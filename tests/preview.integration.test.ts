import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { M1App } from '../src/app/services.js';
import { createTempDir } from './helpers/tmp.js';
import { startTestSiteServer, type TestSiteServer } from './helpers/site-server.js';

describe('seed run', () => {
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

  it('ingests nested sitemap urls, applies url rules, and persists seed pending state', async () => {
    const dir = createTempDir('kvault-seed-');
    const server = await startTestSiteServer();
    servers.push(server);

    const dbPath = join(dir, 'state.db');
    const storageRoot = join(dir, 'storage');
    const app = await M1App.create({ dbPath });
    apps.push(app);

    const project = await app.createProject('Seed Project');
    const site = await app.createSite({
      projectSlug: project.slug,
      name: 'preview-site',
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
          sitemaps: [`${server.baseUrl}/sitemap.xml`],
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
              name: 'allow-content',
              matchType: 'label',
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
            seedMaxDepth: 1,
            crawlMaxDepth: 2,
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    await app.importSiteConfig(site.id, configPath);
    await app.runSeed(site.id);

    expect(await app.getInventorySummary(site.id)).toEqual({
      totalPages: 3,
      pendingPages: 2,
      deniedPages: 1,
      capturedPages: 0,
    });

    expect((await app.listDeniedPages(site.id)).map((row) => row.normalizedUrl)).toEqual([
      `${server.baseUrl}/login`,
    ]);
    expect(
      (await app.listPendingPages(site.id)).map((row) => ({
        url: row.normalizedUrl,
        reason: row.pendingReason,
      })),
    ).toEqual([
      {
        url: `${server.baseUrl}/docs`,
        reason: 'seed_run',
      },
      {
        url: `${server.baseUrl}/product`,
        reason: 'seed_run',
      },
    ]);
    expect((await app.listSampleCaptures(site.id, 5))[0]?.normalizedUrl).toBe(`${server.baseUrl}/product`);
  });

  it('limits initial seed enqueue count to 1.5x target success count', async () => {
    const dir = createTempDir('kvault-seed-target-');
    let port = 0;
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', `http://127.0.0.1:${port}`).pathname;

      if (/^\/page-\d+$/.test(path)) {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(`<!doctype html>
<html>
  <head>
    <title>${path}</title>
    <meta name="description" content="Generic page" />
  </head>
  <body>Generic seed page</body>
</html>`);
        return;
      }

      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start test server');
    }

    port = address.port;
    const baseUrl = `http://127.0.0.1:${port}`;
    servers.push({
      baseUrl,
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        }),
    });

    const app = await M1App.create({ dbPath: join(dir, 'state.db') });
    apps.push(app);
    const project = await app.createProject('Seed Target Project');
    const site = await app.createSite({
      projectSlug: project.slug,
      name: 'seed-target-site',
      baseUrl,
      storageRoot: join(dir, 'storage'),
    });
    const configPath = join(dir, 'site-config.json');

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          seedUrls: [1, 2, 3, 4, 5].map((index) => `${baseUrl}/page-${index}`),
          sitemaps: [],
          rulesBeforeBaseEq: [],
          rulesBeforeStage2Eq: [
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
            seedMaxDepth: 0,
            crawlMaxDepth: 0,
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    await app.importSiteConfig(site.id, configPath);
    const summary = await app.runSeed({
      siteId: site.id,
      targetSuccessCount: 2,
    });

    expect(summary.pageRuns).toBeLessThanOrEqual(3);
    expect(await app.getInventorySummary(site.id)).toEqual({
      totalPages: 5,
      pendingPages: summary.pageRuns,
      deniedPages: 0,
      capturedPages: 0,
    });
  });
});
