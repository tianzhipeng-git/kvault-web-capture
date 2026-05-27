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

class FakeMarkdownTool implements CaptureTool {
  readonly name = 'fake-markdown';
  readonly capabilities = ['markdown'] as const;

  async capture(input: CaptureInput): Promise<CaptureToolResult> {
    return {
      toolName: this.name,
      markdown: `# Fake markdown capture\n\nSource: ${input.url}\n`,
      markdownToolName: this.name,
    };
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

function writeSiteConfig(input: {
  configPath: string;
  baseUrl: string;
  docsArtifacts: ArtifactType[];
  productArtifacts: ArtifactType[];
}): void {
  const host = new URL(input.baseUrl).host;
  writeFileSync(
    input.configPath,
    JSON.stringify(
      {
        seedUrls: [`${input.baseUrl}/docs`],
        sitemaps: [],
        rulesBeforeBaseEq: [
          {
            name: 'block-login',
            matchType: 'url',
            listType: 'blacklist',
            ruleType: 'prefix',
            values: [`${host}/login`],
          },
        ],
        rulesBeforeStage2Eq: [
          {
            name: 'allow-docs',
            matchType: 'label',
            listType: 'whitelist',
            when: [
              {
                key: 'content_type',
                op: 'any_of',
                values: ['docs'],
              },
            ],
            artifacts: input.docsArtifacts,
          },
          {
            name: 'allow-product',
            matchType: 'label',
            listType: 'whitelist',
            when: [
              {
                key: 'content_type',
                op: 'any_of',
                values: ['product'],
              },
            ],
            artifacts: input.productArtifacts,
          },
          {
            name: 'allow-generic',
            matchType: 'label',
            listType: 'whitelist',
            when: [
              {
                key: 'content_type',
                op: 'any_of',
                values: ['generic'],
              },
            ],
            artifacts: ['markdown'],
          },
        ],
        runOptions: {
          seedMaxDepth: 1,
          crawlMaxDepth: 2,
        },
      },
      null,
      2,
    ),
    'utf8',
  );
}

async function createConfiguredApp(input: {
  dir: string;
  server: TestSiteServer;
  captureTools?: CaptureTool[];
  docsArtifacts?: ArtifactType[];
  productArtifacts?: ArtifactType[];
}): Promise<{ app: M1App; siteId: number; dbPath: string; configPath: string }> {
  const dbPath = join(input.dir, 'state.db');
  const storageRoot = join(input.dir, 'storage');
  const app = await M1App.create({
    dbPath,
    captureTools: input.captureTools ?? [
      new HttpBaseTool(),
      new FakeMarkdownTool(),
      new FakeScreenshotTool(),
    ],
  });
  const project = await app.createProject('Crawl Project');
  const site = await app.createSite({
    projectSlug: project.slug,
    name: 'crawl-site',
    baseUrl: input.server.baseUrl,
    storageRoot,
  });
  const configPath = join(input.dir, 'site-config.json');
  writeSiteConfig({
    configPath,
    baseUrl: input.server.baseUrl,
    docsArtifacts: input.docsArtifacts ?? ['markdown', 'screenshot'],
    productArtifacts: input.productArtifacts ?? ['markdown', 'screenshot'],
  });
  await app.importSiteConfig(site.id, configPath);

  return {
    app,
    siteId: site.id,
    dbPath,
    configPath,
  };
}

describe('crawl history planning', () => {
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

  it('skips already successful pages for skip_existing', async () => {
    const dir = createTempDir('kvault-skip-existing-');
    const server = await startTestSiteServer();
    servers.push(server);
    const { app, siteId } = await createConfiguredApp({ dir, server });
    apps.push(app);

    const firstRun = await app.runCrawl({
      siteId,
      updatePolicy: 'force_recrawl_all',
      targetSuccessCount: null,
      staleAfterMs: null,
    });
    const secondRun = await app.runCrawl({
      siteId,
      updatePolicy: 'skip_existing',
      targetSuccessCount: null,
      staleAfterMs: null,
    });

    expect(firstRun.pageRuns).toBe(2);
    expect(firstRun.artifactRuns).toBe(4);
    expect(secondRun.pageRuns).toBe(0);
    expect(secondRun.artifactRuns).toBe(0);
  });

  it('replans only screenshot when skip_existing sees a page gain screenshot in config', async () => {
    const dir = createTempDir('kvault-skip-existing-partial-artifacts-');
    const server = await startTestSiteServer();
    servers.push(server);
    const { app, siteId, dbPath, configPath } = await createConfiguredApp({
      dir,
      server,
      docsArtifacts: ['markdown'],
      productArtifacts: ['markdown'],
    });
    apps.push(app);

    const firstRun = await app.runCrawl({
      siteId,
      updatePolicy: 'force_recrawl_all',
      targetSuccessCount: null,
      staleAfterMs: null,
    });

    writeSiteConfig({
      configPath,
      baseUrl: server.baseUrl,
      docsArtifacts: ['markdown'],
      productArtifacts: ['markdown', 'screenshot'],
    });
    await app.importSiteConfig(siteId, configPath);

    const secondRun = await app.runCrawl({
      siteId,
      updatePolicy: 'skip_existing',
      targetSuccessCount: null,
      staleAfterMs: null,
    });

    const db = await openDatabase(dbPath);
    try {
      const rerunPageRows = await db.all<{
        normalized_url: string;
        required_artifacts_json: string;
      }>(
        `SELECT sp.normalized_url, pr.required_artifacts_json
         FROM page_runs pr
         INNER JOIN site_pages sp ON sp.id = pr.site_page_id
         WHERE pr.crawl_run_id = ?`,
        [secondRun.runId],
      );

      const rerunArtifactRows = await db.all<{
        artifact_type: string;
      }>(
        `SELECT artifact_type
         FROM artifact_runs
         WHERE crawl_run_id = ?`,
        [secondRun.runId],
      );
      const crawlRunRow = await db.get<{
        successful_page_count: number;
        candidate_page_count: number;
        pending_page_count: number;
        denied_page_count: number;
      }>(
        `SELECT successful_page_count, candidate_page_count, pending_page_count, denied_page_count
         FROM crawl_runs
         WHERE id = ?`,
        [secondRun.runId],
      );

      expect(firstRun.pageRuns).toBe(2);
      expect(firstRun.artifactRuns).toBe(2);
      expect(secondRun.pageRuns).toBe(1);
      expect(secondRun.artifactRuns).toBe(1);
      expect(crawlRunRow).toEqual({
        successful_page_count: 1,
        candidate_page_count: 1,
        pending_page_count: 0,
        denied_page_count: 0,
      });
      expect(rerunPageRows).toEqual([
        {
          normalized_url: `${server.baseUrl}/product`,
          required_artifacts_json: '["markdown","screenshot"]',
        },
      ]);
      expect(rerunArtifactRows).toEqual([
        {
          artifact_type: 'screenshot',
        },
      ]);
    } finally {
      await db.close();
    }
  });

  it('replans pending pages for skip_existing so crawl can continue discovery', async () => {
    const dir = createTempDir('kvault-skip-existing-pending-');
    const server = await startTestSiteServer();
    servers.push(server);
    const { app, siteId, configPath } = await createConfiguredApp({
      dir,
      server,
      docsArtifacts: [],
      productArtifacts: [],
    });
    apps.push(app);

    writeSiteConfig({
      configPath,
      baseUrl: server.baseUrl,
      docsArtifacts: [],
      productArtifacts: ['markdown'],
    });
    await app.importSiteConfig(siteId, configPath);

    await app.runSeed(siteId);
    const crawlRun = await app.runCrawl({
      siteId,
      updatePolicy: 'skip_existing',
      targetSuccessCount: null,
      staleAfterMs: null,
    });

    expect(crawlRun.pageRuns).toBe(2);
    expect(crawlRun.artifactRuns).toBe(1);
  });

  it('always replans known inventory for force_recrawl_all', async () => {
    const dir = createTempDir('kvault-force-recrawl-');
    const server = await startTestSiteServer();
    servers.push(server);
    const { app, siteId } = await createConfiguredApp({ dir, server });
    apps.push(app);

    await app.runCrawl({
      siteId,
      updatePolicy: 'force_recrawl_all',
      targetSuccessCount: null,
      staleAfterMs: null,
    });
    const rerun = await app.runCrawl({
      siteId,
      updatePolicy: 'force_recrawl_all',
      targetSuccessCount: null,
      staleAfterMs: null,
    });

    expect(rerun.pageRuns).toBe(2);
    expect(rerun.artifactRuns).toBe(4);
  });

  it('replans stale inventory for stale_after_duration', async () => {
    const dir = createTempDir('kvault-stale-');
    const server = await startTestSiteServer();
    servers.push(server);
    const { app, siteId, dbPath } = await createConfiguredApp({ dir, server });
    apps.push(app);

    await app.runCrawl({
      siteId,
      updatePolicy: 'force_recrawl_all',
      targetSuccessCount: null,
      staleAfterMs: null,
    });

    const db = await openDatabase(dbPath);
    try {
      await db.run(
        `UPDATE site_pages
         SET last_base_at = ?, last_markdown_at = ?, last_screenshot_at = ?
         WHERE site_id = ?`,
        [
        '2020-01-01T00:00:00.000Z',
        '2020-01-01T00:00:00.000Z',
        '2020-01-01T00:00:00.000Z',
        siteId,
        ],
      );
    } finally {
      await db.close();
    }

    const rerun = await app.runCrawl({
      siteId,
      updatePolicy: 'stale_after_duration',
      targetSuccessCount: null,
      staleAfterMs: 60_000,
    });

    expect(rerun.pageRuns).toBe(2);
    expect(rerun.artifactRuns).toBe(4);
  });
});
