import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createWebServer } from '../src/web/server.js';
import { createTempDir } from './helpers/tmp.js';
import { startTestSiteServer, type TestSiteServer } from './helpers/site-server.js';

async function login(server: Awaited<ReturnType<typeof createWebServer>>): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: {
      password: 'secret',
    },
  });
  const cookie = response.cookies[0];

  if (!cookie) {
    throw new Error('Missing auth cookie');
  }

  return `${cookie.name}=${cookie.value}`;
}

describe('web server', () => {
  const servers: Array<Awaited<ReturnType<typeof createWebServer>>> = [];
  const siteServers: TestSiteServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()!.close();
    }

    while (siteServers.length > 0) {
      await siteServers.pop()!.close();
    }
  });

  it('serves authenticated project, site, config, and run flows', async () => {
    const dir = createTempDir('kvault-web-');
    const dbPath = join(dir, 'state.db');
    const webServer = await createWebServer({
      dbPath,
      adminPassword: 'secret',
      maxConcurrentRuns: 2,
    });
    servers.push(webServer);

    const siteServer = await startTestSiteServer();
    siteServers.push(siteServer);

    const unauthenticated = await webServer.inject({
      method: 'GET',
      url: '/api/projects',
    });
    expect(unauthenticated.statusCode).toBe(401);

    const authCookie = await login(webServer);

    const projectResponse = await webServer.inject({
      method: 'POST',
      url: '/api/projects',
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
      payload: {
        name: 'Web Project',
      },
    });
    expect(projectResponse.statusCode).toBe(200);

    const projectId = (await webServer.inject({
      method: 'GET',
      url: '/api/projects',
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
    }).then((response) => response.json())).items[0].projectId as number;

    const exportResponse = await webServer.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/export`,
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
    });
    expect(exportResponse.statusCode).toBe(200);
    expect(exportResponse.headers['content-type']).toContain('application/zip');
    expect(exportResponse.rawPayload.length).toBeGreaterThan(0);

    const preparedExportResponse = await webServer.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/export/prepare`,
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
      payload: {
        artifacts: [],
      },
    });
    expect(preparedExportResponse.statusCode).toBe(200);
    const preparedExport = preparedExportResponse.json() as { token: string; fileName: string };
    expect(preparedExport.token).toBeTruthy();
    expect(preparedExport.fileName).toMatch(/\.zip$/);

    const preparedDownloadResponse = await webServer.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/export/download/${preparedExport.token}`,
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
    });
    expect(preparedDownloadResponse.statusCode).toBe(200);
    expect(preparedDownloadResponse.headers['content-type']).toContain('application/zip');
    expect(preparedDownloadResponse.headers['content-disposition']).toContain(preparedExport.fileName);
    expect(preparedDownloadResponse.rawPayload.length).toBeGreaterThan(0);

    const siteResponse = await webServer.inject({
      method: 'POST',
      url: '/api/sites',
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
      payload: {
        projectId,
        name: 'docs-site',
        baseUrl: siteServer.baseUrl,
        storageRoot: join(dir, 'storage'),
      },
    });
    const site = siteResponse.json() as { id: number; name: string };
    expect(site.id).toBeGreaterThan(0);

    const configResponse = await webServer.inject({
      method: 'PUT',
      url: `/api/sites/${site.id}/config`,
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
      payload: {
        seedUrls: [`${siteServer.baseUrl}/docs`],
        sitemaps: [`${siteServer.baseUrl}/sitemap.xml`],
        rulesBeforeBaseEq: [],
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
    });
    expect(configResponse.statusCode).toBe(200);

    const seedResponse = await webServer.inject({
      method: 'POST',
      url: `/api/sites/${site.id}/runs/seed`,
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
      payload: {},
    });
    expect(seedResponse.statusCode).toBe(200);
    const runId = (seedResponse.json() as { runId: number }).runId;
    expect(runId).toBeGreaterThan(0);

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const runSummaryResponse = await webServer.inject({
        method: 'GET',
        url: `/api/runs/${runId}`,
        cookies: {
          kvault_session: authCookie.split('=')[1],
        },
      });
      const runSummary = runSummaryResponse.json() as { statusLabel: string };

      if (runSummary.statusLabel !== '进行中') {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const overviewResponse = await webServer.inject({
      method: 'GET',
      url: `/api/sites/${site.id}/overview`,
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
    });
    const overview = overviewResponse.json() as {
      pagesNeedReview: number;
      totalPages: number;
      workflowSteps: Array<{ title: string }>;
    };

    expect(overview.totalPages).toBeGreaterThan(0);
    expect(overview.pagesNeedReview).toBeGreaterThan(0);
    expect(overview.workflowSteps.map((step) => step.title)).toContain('确认采集规则');

    const runLogsResponse = await webServer.inject({
      method: 'GET',
      url: `/api/runs/${runId}/logs`,
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
    });
    const runLogs = runLogsResponse.json() as {
      items: Array<{ event: string; meta: { relativePath?: string } | null }>;
    };
    expect(runLogs.items.some((item) => item.event === 'runtime_log_ready')).toBe(true);
    expect(
      runLogs.items.find((item) => item.event === 'runtime_log_ready')?.meta?.relativePath,
    ).toBe(`runs/${runId}/runtime.log`);

    const runtimeLogResponse = await webServer.inject({
      method: 'GET',
      url: `/api/runs/${runId}/runtime-log?tail=20`,
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
    });
    const runtimeLog = runtimeLogResponse.json() as {
      relativePath: string;
      content: string;
    };
    expect(runtimeLog.relativePath).toBe(`runs/${runId}/runtime.log`);
    expect(runtimeLog.content).toContain('Runtime log initialized');

    const pageResponse = await webServer.inject({
      method: 'GET',
      url: `/api/sites/${site.id}/pages?page=1&pageSize=10&status=stage2_pending`,
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
    });
    const pageList = pageResponse.json() as {
      rows: Array<{ sitePageId: number; businessStatus: string }>;
    };
    expect(pageList.rows[0]?.businessStatus).toBe('待确认');

    const runScopedPageResponse = await webServer.inject({
      method: 'GET',
      url: `/api/sites/${site.id}/pages?page=1&pageSize=10&crawlRunId=${runId}`,
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
    });
    const runScopedPageList = runScopedPageResponse.json() as {
      rows: Array<{ sitePageId: number }>;
      total: number;
    };
    expect(runScopedPageList.total).toBeGreaterThan(0);

    const pageDetailResponse = await webServer.inject({
      method: 'GET',
      url: `/api/sites/${site.id}/pages/${pageList.rows[0]!.sitePageId}`,
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
    });
    const pageDetail = pageDetailResponse.json() as {
      latestBase: { shouldRun: boolean; succeeded: boolean };
      latestMarkdown: { shouldRun: boolean; succeeded: boolean; reason: string };
      latestScreenshot: { shouldRun: boolean; succeeded: boolean; reason: string };
      runHistory: Array<{ runId: number; pageRuns: unknown[] }>;
    };
    expect(pageDetail.latestBase.shouldRun).toBe(true);
    expect(pageDetail.latestBase.succeeded).toBe(true);
    expect(pageDetail.latestMarkdown.shouldRun).toBe(false);
    expect(pageDetail.latestScreenshot.shouldRun).toBe(false);
    expect(pageDetail.runHistory.some((run) => run.runId === runId && run.pageRuns.length > 0)).toBe(
      true,
    );
  });
});
