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
      apps.pop()!.close();
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
    const app = new M1App({ dbPath });
    apps.push(app);

    const project = app.createProject('Seed Project');
    const site = app.createSite({
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

    app.importSiteConfig(site.id, configPath);
    await app.runSeed(site.id);

    expect(app.getInventorySummary(site.id)).toEqual({
      totalPages: 3,
      pendingPages: 2,
      deniedPages: 1,
      capturedPages: 0,
    });

    expect(app.listDeniedPages(site.id).map((row) => row.normalizedUrl)).toEqual([
      `${server.baseUrl}/login`,
    ]);
    expect(
      app.listPendingPages(site.id).map((row) => ({
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
    expect(app.listSampleCaptures(site.id, 5)[0]?.normalizedUrl).toBe(`${server.baseUrl}/product`);
  });
});
