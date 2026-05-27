/**
 * Integration tests for capture outcome edge cases:
 *   - artifact capture failure → DB failure records + site_page status
 *   - stage2 deny → page not captured, inventory correctly denied
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { M1App } from '../src/app/services.js';
import { HttpBaseTool } from '../src/capture/captools/index.js';
import type { CaptureInput, CaptureTool, CaptureToolResult } from '../src/capture/types.js';
import { openDatabase } from '../src/db/database.js';
import type { ArtifactType } from '../src/domain/types.js';
import { createTempDir } from './helpers/tmp.js';
import { startTestSiteServer, type TestSiteServer } from './helpers/site-server.js';

// ──────────────────────────── tool stubs ─────────────────────────────────────

class AlwaysFailMarkdownTool implements CaptureTool {
  readonly name = 'always-fail-markdown';
  readonly capabilities = ['markdown'] as const;

  async capture(input: CaptureInput): Promise<CaptureToolResult> {
    throw new Error(`markdown intentionally failed for ${input.url}`);
  }
}

class FakeScreenshotTool implements CaptureTool {
  readonly name = 'fake-screenshot';
  readonly capabilities = ['screenshot'] as const;

  async capture(): Promise<CaptureToolResult> {
    return {
      toolName: this.name,
      screenshot: Buffer.from('fake png data'),
      screenshotExtension: 'png',
    };
  }
}

class FakeMarkdownTool implements CaptureTool {
  readonly name = 'fake-markdown';
  readonly capabilities = ['markdown'] as const;

  async capture(input: CaptureInput): Promise<CaptureToolResult> {
    return {
      toolName: this.name,
      markdown: `# Fake\n\nSource: ${input.url}\n`,
      markdownToolName: this.name,
    };
  }
}

// ──────────────────────────── helpers ────────────────────────────────────────

function writeSiteConfig(input: {
  configPath: string;
  baseUrl: string;
  docsArtifacts: ArtifactType[];
  allowLabel?: string;
  denyUrlPrefix?: string;
}): void {
  const host = new URL(input.baseUrl).host;
  const rules: unknown[] = [];

  if (input.denyUrlPrefix) {
    rules.push({
      name: 'deny-by-url',
      matchType: 'url',
      listType: 'blacklist',
      ruleType: 'prefix',
      values: [`${host}${input.denyUrlPrefix}`],
    });
  }

  if (input.allowLabel) {
    rules.push({
      name: 'allow-docs',
      matchType: 'label',
      listType: 'whitelist',
      when: [{ key: 'content_type', op: 'any_of', values: [input.allowLabel] }],
      artifacts: input.docsArtifacts,
    });
  }

  writeFileSync(
    input.configPath,
    JSON.stringify(
      {
        seedUrls: [`${input.baseUrl}/docs`],
        sitemaps: [],
        rulesBeforeBaseEq: [],
        rulesBeforeStage2Eq: rules,
        runOptions: { seedMaxDepth: 1, crawlMaxDepth: 2 },
      },
      null,
      2,
    ),
    'utf8',
  );
}

// ──────────────────────────── test suites ────────────────────────────────────

describe('artifact capture failure outcomes', () => {
  const servers: TestSiteServer[] = [];
  const apps: M1App[] = [];

  afterEach(async () => {
    while (apps.length > 0) {
      await apps.pop()!.close();
    }
    while (servers.length > 0) {
      await servers.pop()!.close();
    }
  });

  it('records failed artifact_run and failed site_page markdown status when markdown tool throws', async () => {
    const dir = createTempDir('kvault-artifact-fail-');
    const server = await startTestSiteServer();
    servers.push(server);

    const dbPath = join(dir, 'state.db');
    const storageRoot = join(dir, 'storage');
    const app = await M1App.create({
      dbPath,
      captureTools: [new HttpBaseTool(), new AlwaysFailMarkdownTool(), new FakeScreenshotTool()],
    });
    apps.push(app);

    const project = await app.createProject('P');
    const site = await app.createSite({
      projectSlug: project.slug,
      name: 's',
      baseUrl: server.baseUrl,
      storageRoot,
    });
    const configPath = join(dir, 'site-config.json');
    writeSiteConfig({
      configPath,
      baseUrl: server.baseUrl,
      docsArtifacts: ['markdown', 'screenshot'],
      allowLabel: 'docs',
    });
    await app.importSiteConfig(site.id, configPath);

    const runSummary = await app.runCrawl({
      siteId: site.id,
      updatePolicy: 'force_recrawl_all',
      targetSuccessCount: null,
      staleAfterMs: null,
    });

    const db = await openDatabase(dbPath);
    try {
      const failedMarkdown = await db.all<{ artifact_type: string; status: string }>(
        `SELECT artifact_type, status FROM artifact_runs WHERE status = 'failed'`,
        [],
      );

      const succeededScreenshot = await db.all<{ artifact_type: string; status: string }>(
        `SELECT artifact_type, status FROM artifact_runs WHERE status = 'succeeded' AND artifact_type = 'screenshot'`,
        [],
      );

      const sitePageRow = await db.get<{
        last_markdown_status: string | null;
        last_screenshot_status: string | null;
      }>(
        `SELECT sp.last_markdown_status, sp.last_screenshot_status
         FROM site_pages sp
         WHERE sp.site_id = ? AND sp.normalized_url LIKE '%/docs'`,
        [site.id],
      );

      expect(runSummary.pageRuns).toBeGreaterThan(0);
      expect(failedMarkdown.length).toBeGreaterThan(0);
      expect(failedMarkdown[0].artifact_type).toBe('markdown');
      expect(succeededScreenshot.length).toBeGreaterThan(0);
      expect(sitePageRow?.last_markdown_status).toBe('failed');
      expect(sitePageRow?.last_screenshot_status).toBe('succeeded');
    } finally {
      await db.close();
    }
  });

  it('independent artifact failures do not block other artifact types from recording', async () => {
    const dir = createTempDir('kvault-partial-artifact-fail-');
    const server = await startTestSiteServer();
    servers.push(server);

    const dbPath = join(dir, 'state.db');
    const storageRoot = join(dir, 'storage');
    const app = await M1App.create({
      dbPath,
      captureTools: [new HttpBaseTool(), new AlwaysFailMarkdownTool(), new FakeScreenshotTool()],
    });
    apps.push(app);

    const project = await app.createProject('P2');
    const site = await app.createSite({
      projectSlug: project.slug,
      name: 's2',
      baseUrl: server.baseUrl,
      storageRoot,
    });
    const configPath = join(dir, 'site-config.json');
    writeSiteConfig({
      configPath,
      baseUrl: server.baseUrl,
      docsArtifacts: ['markdown', 'screenshot'],
      allowLabel: 'docs',
    });
    await app.importSiteConfig(site.id, configPath);

    await app.runCrawl({
      siteId: site.id,
      updatePolicy: 'force_recrawl_all',
      targetSuccessCount: null,
      staleAfterMs: null,
    });

    const db = await openDatabase(dbPath);
    try {
      const allArtifacts = await db.all<{ artifact_type: string; status: string }>(
        `SELECT artifact_type, status FROM artifact_runs ORDER BY artifact_type`,
        [],
      );

      const mdRows = allArtifacts.filter((r) => r.artifact_type === 'markdown');
      const ssRows = allArtifacts.filter((r) => r.artifact_type === 'screenshot');

      expect(mdRows.every((r) => r.status === 'failed')).toBe(true);
      expect(ssRows.every((r) => r.status === 'succeeded')).toBe(true);
    } finally {
      await db.close();
    }
  });
});

describe('stage2 deny outcomes', () => {
  const servers: TestSiteServer[] = [];
  const apps: M1App[] = [];

  afterEach(async () => {
    while (apps.length > 0) {
      await apps.pop()!.close();
    }
    while (servers.length > 0) {
      await servers.pop()!.close();
    }
  });

  it('pages matching deny url rule are not given artifact_runs', async () => {
    const dir = createTempDir('kvault-stage2-deny-');
    const server = await startTestSiteServer();
    servers.push(server);

    const dbPath = join(dir, 'state.db');
    const storageRoot = join(dir, 'storage');
    const app = await M1App.create({
      dbPath,
      captureTools: [new HttpBaseTool(), new FakeMarkdownTool(), new FakeScreenshotTool()],
    });
    apps.push(app);

    const project = await app.createProject('P3');
    const site = await app.createSite({
      projectSlug: project.slug,
      name: 's3',
      baseUrl: server.baseUrl,
      storageRoot,
    });
    const configPath = join(dir, 'site-config.json');

    const host = new URL(server.baseUrl).host;
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          seedUrls: [`${server.baseUrl}/docs`],
          sitemaps: [],
          rulesBeforeBaseEq: [],
          rulesBeforeStage2Eq: [
            {
              name: 'deny-product',
              matchType: 'url',
              listType: 'blacklist',
              ruleType: 'prefix',
              values: [`${host}/product`],
            },
            {
              name: 'allow-docs',
              matchType: 'label',
              listType: 'whitelist',
              when: [{ key: 'content_type', op: 'any_of', values: ['docs'] }],
              artifacts: ['markdown'],
            },
          ],
          runOptions: { seedMaxDepth: 1, crawlMaxDepth: 2 },
        },
        null,
        2,
      ),
      'utf8',
    );
    await app.importSiteConfig(site.id, configPath);

    const runSummary = await app.runCrawl({
      siteId: site.id,
      updatePolicy: 'force_recrawl_all',
      targetSuccessCount: null,
      staleAfterMs: null,
    });

    const db = await openDatabase(dbPath);
    try {
      const pageRuns = await db.all<{
        normalized_url: string;
        decision_outcome: string;
        required_artifacts_json: string;
      }>(
        `SELECT sp.normalized_url, pr.decision_outcome, pr.required_artifacts_json
         FROM page_runs pr
         INNER JOIN site_pages sp ON sp.id = pr.site_page_id
         WHERE pr.crawl_run_id = ?`,
        [runSummary.runId],
      );

      const artifactRuns = await db.all<{ artifact_type: string; status: string }>(
        `SELECT artifact_type, status FROM artifact_runs WHERE crawl_run_id = ?`,
        [runSummary.runId],
      );

      const productRun = pageRuns.find((r) => r.normalized_url.endsWith('/product'));
      const docsRun = pageRuns.find((r) => r.normalized_url.endsWith('/docs'));

      expect(productRun?.decision_outcome).toBe('deny');
      expect(docsRun?.decision_outcome).toBe('allow');

      const productArtifacts = artifactRuns.filter((r) =>
        pageRuns.find((pr) => pr.normalized_url.endsWith('/product') && pr.decision_outcome === 'deny'),
      );

      expect(artifactRuns.filter((r) => r.artifact_type === 'markdown' && r.status === 'succeeded')).toHaveLength(1);
      expect(runSummary.artifactRuns).toBe(1);
    } finally {
      await db.close();
    }
  });

  it('stage2 deny pages do not contribute to successful artifact counts', async () => {
    const dir = createTempDir('kvault-stage2-deny-counts-');
    const server = await startTestSiteServer();
    servers.push(server);

    const dbPath = join(dir, 'state.db');
    const storageRoot = join(dir, 'storage');
    const app = await M1App.create({
      dbPath,
      captureTools: [new HttpBaseTool(), new FakeMarkdownTool(), new FakeScreenshotTool()],
    });
    apps.push(app);

    const project = await app.createProject('P4');
    const site = await app.createSite({
      projectSlug: project.slug,
      name: 's4',
      baseUrl: server.baseUrl,
      storageRoot,
    });

    const host = new URL(server.baseUrl).host;
    const configPath = join(dir, 'site-config.json');
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          seedUrls: [`${server.baseUrl}/docs`],
          sitemaps: [],
          rulesBeforeBaseEq: [],
          rulesBeforeStage2Eq: [
            {
              name: 'deny-all',
              matchType: 'url',
              listType: 'blacklist',
              ruleType: 'prefix',
              values: [`${host}/`],
            },
          ],
          runOptions: { seedMaxDepth: 1, crawlMaxDepth: 2 },
        },
        null,
        2,
      ),
      'utf8',
    );
    await app.importSiteConfig(site.id, configPath);

    const runSummary = await app.runCrawl({
      siteId: site.id,
      updatePolicy: 'force_recrawl_all',
      targetSuccessCount: null,
      staleAfterMs: null,
    });

    expect(runSummary.pageRuns).toBeGreaterThan(0);
    expect(runSummary.artifactRuns).toBe(0);
  });
});
