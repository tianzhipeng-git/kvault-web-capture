import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { M1App } from '../src/app/services.js';
import { openDatabase } from '../src/db/database.js';
import type { MarkdownCaptureAdapter } from '../src/markdown/fake-markdown-adapter.js';
import { createTempDir } from './helpers/tmp.js';
import { startTestSiteServer, type TestSiteServer } from './helpers/site-server.js';

class SwitchableMarkdownAdapter implements MarkdownCaptureAdapter {
  private failedUrls = new Set<string>();

  fail(url: string): void {
    this.failedUrls.add(url);
  }

  recover(url: string): void {
    this.failedUrls.delete(url);
  }

  async capture(url: string): Promise<string> {
    if (this.failedUrls.has(url)) {
      throw new Error(`forced markdown failure for ${url}`);
    }

    return `# Markdown\n\nSource: ${url}\n`;
  }
}

async function createConfiguredApp(input: {
  dir: string;
  server: TestSiteServer;
  markdownAdapter?: MarkdownCaptureAdapter;
}): Promise<{ app: M1App; siteId: number; dbPath: string }> {
  const dbPath = join(input.dir, 'state.db');
  const storageRoot = join(input.dir, 'storage');
  const app = new M1App({
    dbPath,
    markdownAdapter: input.markdownAdapter,
  });
  const project = app.createProject('Crawl Project');
  const site = app.createSite({
    projectSlug: project.slug,
    name: 'crawl-site',
    baseUrl: input.server.baseUrl,
    storageRoot,
  });
  const host = new URL(input.server.baseUrl).host;
  const configPath = join(input.dir, 'site-config.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        seedUrls: [`${input.server.baseUrl}/docs`],
        sitemaps: [],
        urlRules: [
          {
            name: 'block-login',
            listType: 'blacklist',
            ruleType: 'prefix',
            values: [`${host}/login`],
          },
        ],
        tagRules: [
          {
            name: 'allow-content',
            listType: 'whitelist',
            when: [
              {
                key: 'content_type',
                op: 'any_of',
                values: ['docs', 'product', 'generic'],
              },
            ],
            artifacts: ['markdown'],
          },
        ],
        runOptions: {
          previewMaxDepth: 1,
          crawlMaxDepth: 2,
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  app.importSiteConfig(site.id, configPath);

  return {
    app,
    siteId: site.id,
    dbPath,
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
    expect(firstRun.artifactRuns).toBe(2);
    expect(secondRun.pageRuns).toBe(0);
    expect(secondRun.artifactRuns).toBe(0);
  });

  it('replans pages with failed artifacts for rerun_failed_artifacts', async () => {
    const dir = createTempDir('kvault-rerun-failed-');
    const server = await startTestSiteServer();
    servers.push(server);
    const adapter = new SwitchableMarkdownAdapter();
    adapter.fail(`${server.baseUrl}/product`);
    const { app, siteId } = await createConfiguredApp({
      dir,
      server,
      markdownAdapter: adapter,
    });
    apps.push(app);

    const failedRun = await app.runCrawl({
      siteId,
      updatePolicy: 'force_recrawl_all',
      targetSuccessCount: null,
      staleAfterMs: null,
    });

    adapter.recover(`${server.baseUrl}/product`);

    const rerun = await app.runCrawl({
      siteId,
      updatePolicy: 'rerun_failed_artifacts',
      targetSuccessCount: null,
      staleAfterMs: null,
    });

    expect(failedRun.pageRuns).toBe(2);
    expect(failedRun.artifactRuns).toBe(2);
    expect(rerun.pageRuns).toBe(1);
    expect(rerun.artifactRuns).toBe(1);
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
    expect(rerun.artifactRuns).toBe(2);
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
         SET last_base_at = ?, last_markdown_at = ?
         WHERE site_id = ?`,
      ).run('2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', siteId);
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
    expect(rerun.artifactRuns).toBe(2);
  });
});
