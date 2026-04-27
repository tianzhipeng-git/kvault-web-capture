import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { M1App } from '../src/app/services.js';
import { openDatabase } from '../src/db/database.js';
import type { ArtifactType } from '../src/domain/types.js';
import { FakeMarkdownCaptureAdapter } from '../src/markdown/fake-markdown-adapter.js';
import type { MarkdownCaptureAdapter } from '../src/markdown/markdown-adapter.js';
import { FakeScreenshotCaptureAdapter } from '../src/screenshot/fake-screenshot-adapter.js';
import type { ScreenshotCaptureAdapter, ScreenshotCaptureResult } from '../src/screenshot/screenshot-adapter.js';
import { createTempDir } from './helpers/tmp.js';
import { startTestSiteServer, type TestSiteServer } from './helpers/site-server.js';

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
  markdownAdapter?: MarkdownCaptureAdapter;
  screenshotAdapter?: ScreenshotCaptureAdapter;
  docsArtifacts?: ArtifactType[];
  productArtifacts?: ArtifactType[];
}): Promise<{ app: M1App; siteId: number; dbPath: string; configPath: string }> {
  const dbPath = join(input.dir, 'state.db');
  const storageRoot = join(input.dir, 'storage');
  const app = new M1App({
    dbPath,
    markdownAdapter: input.markdownAdapter ?? new FakeMarkdownCaptureAdapter(),
    screenshotAdapter: input.screenshotAdapter ?? new FakeScreenshotCaptureAdapter(),
  });
  const project = app.createProject('Crawl Project');
  const site = app.createSite({
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
  app.importSiteConfig(site.id, configPath);

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
      apps.pop()!.close();
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
    app.importSiteConfig(siteId, configPath);

    const secondRun = await app.runCrawl({
      siteId,
      updatePolicy: 'skip_existing',
      targetSuccessCount: null,
      staleAfterMs: null,
    });

    const db = openDatabase(dbPath);
    try {
      const rerunPageRows = db.prepare(
        `SELECT sp.normalized_url, pr.required_artifacts_json
         FROM page_runs pr
         INNER JOIN site_pages sp ON sp.id = pr.site_page_id
         WHERE pr.crawl_run_id = ?`,
      ).all(secondRun.runId) as Array<{
        normalized_url: string;
        required_artifacts_json: string;
      }>;

      const rerunArtifactRows = db.prepare(
        `SELECT artifact_type
         FROM artifact_runs
         WHERE crawl_run_id = ?`,
      ).all(secondRun.runId) as Array<{
        artifact_type: string;
      }>;
      const crawlRunRow = db.prepare(
        `SELECT successful_page_count, candidate_page_count, pending_page_count, denied_page_count
         FROM crawl_runs
         WHERE id = ?`,
      ).get(secondRun.runId) as {
        successful_page_count: number;
        candidate_page_count: number;
        pending_page_count: number;
        denied_page_count: number;
      };

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
      db.close();
    }
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

    const db = openDatabase(dbPath);
    try {
      db.prepare(
        `UPDATE site_pages
         SET last_base_at = ?, last_markdown_at = ?, last_screenshot_at = ?
         WHERE site_id = ?`,
      ).run(
        '2020-01-01T00:00:00.000Z',
        '2020-01-01T00:00:00.000Z',
        '2020-01-01T00:00:00.000Z',
        siteId,
      );
    } finally {
      db.close();
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
