import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWebServer } from '../src/web/server.js';
import { openDatabase } from '../src/db/database.js';
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForFileToBeRemoved(path: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!await fileExists(path)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('web server', () => {
  const servers: Array<Awaited<ReturnType<typeof createWebServer>>> = [];
  const siteServers: TestSiteServer[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();

    while (servers.length > 0) {
      await servers.pop()!.close();
    }

    while (siteServers.length > 0) {
      await siteServers.pop()!.close();
    }
  });

  it('expands page links through the authenticated web API', async () => {
    const dir = createTempDir('kvault-web-link-expand-');
    const webServer = await createWebServer({
      dbPath: join(dir, 'state.db'),
      adminPassword: 'secret',
      maxConcurrentRuns: 1,
    });
    servers.push(webServer);

    const siteServer = await startTestSiteServer();
    siteServers.push(siteServer);

    const unauthenticated = await webServer.inject({
      method: 'POST',
      url: '/api/links/expand',
      payload: { url: `${siteServer.baseUrl}/docs` },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const authCookie = await login(webServer);
    const response = await webServer.inject({
      method: 'POST',
      url: '/api/links/expand',
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
      payload: { url: `${siteServer.baseUrl}/docs` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      sourceUrl: `${siteServer.baseUrl}/docs`,
      sourceType: 'page',
      links: [`${siteServer.baseUrl}/product`],
    });
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
    const preparedExportPath = join('.local', 'exports', preparedExport.fileName);
    expect(await fileExists(preparedExportPath)).toBe(true);

    const preparedDownloadResponse = await webServer.inject({
      method: 'GET',
      url: `/api/exports/download/${preparedExport.token}`,
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
    });
    expect(preparedDownloadResponse.statusCode).toBe(200);
    expect(preparedDownloadResponse.headers['content-type']).toContain('application/zip');
    expect(preparedDownloadResponse.headers['content-disposition']).toContain(preparedExport.fileName);
    expect(preparedDownloadResponse.rawPayload.length).toBeGreaterThan(0);
    await waitForFileToBeRemoved(preparedExportPath);
    expect(await fileExists(preparedExportPath)).toBe(false);

    const repeatedPreparedDownloadResponse = await webServer.inject({
      method: 'GET',
      url: `/api/exports/download/${preparedExport.token}`,
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
    });
    expect(repeatedPreparedDownloadResponse.statusCode).toBe(404);

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

    const faviconBytes = Buffer.from([0, 1, 2, 3]);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(faviconBytes, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    const faviconFetchResponse = await webServer.inject({
      method: 'POST',
      url: `/api/sites/${site.id}/favicon/fetch`,
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
    });
    expect(faviconFetchResponse.statusCode).toBe(200);
    expect(faviconFetchResponse.json()).toEqual({
      status: 'ok',
      byteLength: faviconBytes.length,
      contentType: 'image/png',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://www.google.com/s2/favicons?domain=127.0.0.1&sz=64`,
    );

    const faviconResponse = await webServer.inject({
      method: 'GET',
      url: `/api/sites/${site.id}/favicon.ico`,
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
    });
    expect(faviconResponse.statusCode).toBe(200);
    expect(faviconResponse.headers['content-type']).toContain('image/png');
    expect(faviconResponse.rawPayload).toEqual(faviconBytes);

    const sitesResponse = await webServer.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/sites`,
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
    });
    expect((sitesResponse.json() as { items: Array<{ hasFavicon: boolean }> }).items[0]?.hasFavicon).toBe(true);

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

    const pathTreeResponse = await webServer.inject({
      method: 'GET',
      url: `/api/sites/${site.id}/path-tree`,
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
    });
    const pathTree = pathTreeResponse.json() as {
      totalUrls: number;
      root: { children: Array<{ name: string }> };
      text: string;
    };
    const expectedTld = new URL(siteServer.baseUrl).hostname.split('.').at(-1);
    expect(pathTreeResponse.statusCode).toBe(200);
    expect(pathTree.totalUrls).toBeGreaterThan(0);
    expect(pathTree.root.children.map((node) => node.name)).toContain(expectedTld);
    expect(pathTree.text).toContain(expectedTld);

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
      url: `/api/runs/${runId}/runtime-log?tail=200`,
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
      rows: Array<{ sitePageId: number; title: string; businessStatus: string }>;
    };
    expect(pageList.rows[0]?.businessStatus).toBe('待确认');

    const multiStatusPageResponse = await webServer.inject({
      method: 'GET',
      url: `/api/sites/${site.id}/pages?page=1&pageSize=10&status=stage2_pending&status=url_rule_denied`,
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
    });
    const multiStatusPageList = multiStatusPageResponse.json() as {
      rows: Array<{ businessStatus: string }>;
      total: number;
    };
    expect(multiStatusPageList.total).toBeGreaterThan(0);
    expect(multiStatusPageList.rows.some((row) => row.businessStatus === '待确认')).toBe(true);

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

    const classificationPreviewResponse = await webServer.inject({
      method: 'POST',
      url: `/api/sites/${site.id}/pages/${pageList.rows[0]!.sitePageId}/classification/preview`,
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
    });
    expect(classificationPreviewResponse.statusCode).toBe(200);
    const expectedContentType = pageList.rows[0]!.title.toLowerCase().includes('docs')
      ? 'docs'
      : pageList.rows[0]!.title.toLowerCase().includes('product')
        ? 'product'
        : 'generic';
    expect(classificationPreviewResponse.json()).toEqual({
      labels: {
        content_type: [expectedContentType],
      },
    });
  });

  it('serves screenshot artifact files with their real content length', async () => {
    const dir = createTempDir('kvault-web-artifact-');
    const dbPath = join(dir, 'state.db');
    const webServer = await createWebServer({
      dbPath,
      adminPassword: 'secret',
      maxConcurrentRuns: 2,
    });
    servers.push(webServer);
    const authCookie = await login(webServer);

    const db = await openDatabase(dbPath);
    const now = new Date().toISOString();
    const screenshotPath = join(dir, 'storage', 'artifacts', 'run-1', 'page-1', 'screenshot.png');
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await mkdir(dirname(screenshotPath), { recursive: true });
    await writeFile(screenshotPath, pngBytes);

    const project = await db.run(
      'INSERT INTO projects (name, slug, label_definitions_json, created_at) VALUES (?, ?, ?, ?)',
      ['Artifact Project', 'artifact-project', '[]', now],
    );
    const site = await db.run(
      `INSERT INTO sites (
        project_id, name, base_url, storage_root, config_json, updated_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        project.lastInsertId,
        'artifact-site',
        'https://example.com',
        join(dir, 'storage'),
        JSON.stringify({ seedUrls: [], sitemaps: [], rulesBeforeBaseEq: [], rulesBeforeStage2Eq: [] }),
        now,
        now,
      ],
    );
    const run = await db.run(
      `INSERT INTO crawl_runs (
        site_id, run_type, update_policy, config_snapshot_json, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        site.lastInsertId,
        'crawl_run',
        'always',
        JSON.stringify({ seedUrls: [], sitemaps: [], rulesBeforeBaseEq: [], rulesBeforeStage2Eq: [] }),
        'succeeded',
        now,
      ],
    );
    const page = await db.run(
      `INSERT INTO site_pages (
        site_id, discovered_url, normalized_url, inventory_status, discovery_source,
        last_stage_decision_json, first_discovered_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        site.lastInsertId,
        'https://example.com/page',
        'https://example.com/page',
        'stage2_captured',
        'seed',
        JSON.stringify({ outcome: 'allow', requiredArtifacts: ['screenshot'] }),
        now,
        now,
        now,
      ],
    );
    const pageRun = await db.run(
      `INSERT INTO page_runs (
        crawl_run_id, site_page_id, started_at, finished_at, base_capture_status,
        title, meta_description, body_text, classification_labels_json, rule_outcome,
        decision_outcome, required_artifacts_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.lastInsertId,
        page.lastInsertId,
        now,
        now,
        'succeeded',
        'Artifact page',
        '',
        '',
        '{}',
        'allow',
        'allow',
        '["screenshot"]',
      ],
    );
    const artifact = await db.run(
      `INSERT INTO artifact_runs (
        crawl_run_id, page_run_id, site_page_id, artifact_type, status,
        started_at, finished_at, output_path, content, error_message, meta_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.lastInsertId,
        pageRun.lastInsertId,
        page.lastInsertId,
        'screenshot',
        'succeeded',
        now,
        now,
        screenshotPath,
        null,
        null,
        '{"tool":"test"}',
      ],
    );

    const response = await webServer.inject({
      method: 'GET',
      url: `/api/sites/${site.lastInsertId}/artifacts/${artifact.lastInsertId}/file`,
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/png');
    expect(response.headers['content-length']).toBe(String(pngBytes.length));
    expect(response.rawPayload).toEqual(pngBytes);
    await db.close();
  });

  it('marks orphan running runs as cancelled when cancel is requested', async () => {
    const dir = createTempDir('kvault-web-orphan-run-');
    const dbPath = join(dir, 'state.db');
    const webServer = await createWebServer({
      dbPath,
      adminPassword: 'secret',
      maxConcurrentRuns: 2,
    });
    servers.push(webServer);
    const authCookie = await login(webServer);

    const db = await openDatabase(dbPath);
    const now = new Date().toISOString();
    const config = {
      seedUrls: [],
      sitemaps: [],
      rulesBeforeBaseEq: [],
      rulesBeforeStage2Eq: [],
      runOptions: {
        seedMaxDepth: 1,
        crawlMaxDepth: 0,
      },
    };
    const project = await db.run(
      'INSERT INTO projects (name, slug, label_definitions_json, created_at) VALUES (?, ?, ?, ?)',
      ['Orphan Project', 'orphan-project', '[]', now],
    );
    const site = await db.run(
      `INSERT INTO sites (
        project_id, name, base_url, storage_root, config_json, updated_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        project.lastInsertId,
        'orphan-site',
        'https://example.com',
        join(dir, 'storage'),
        JSON.stringify(config),
        now,
        now,
      ],
    );
    const run = await db.run(
      `INSERT INTO crawl_runs (
        site_id, run_type, update_policy, config_snapshot_json, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        site.lastInsertId,
        'crawl_run',
        'force_recrawl_all',
        JSON.stringify(config),
        'running',
        now,
      ],
    );

    const cancelResponse = await webServer.inject({
      method: 'POST',
      url: `/api/runs/${run.lastInsertId}/cancel`,
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
    });

    expect(cancelResponse.statusCode).toBe(200);
    expect(cancelResponse.json()).toMatchObject({
      runId: run.lastInsertId,
      status: 'cancelled',
      statusLabel: '已取消',
    });

    const summaryResponse = await webServer.inject({
      method: 'GET',
      url: `/api/runs/${run.lastInsertId}`,
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
    });
    const summary = summaryResponse.json() as { statusLabel: string; finishedAt: string | null };
    expect(summary.statusLabel).toBe('已取消');
    expect(summary.finishedAt).not.toBeNull();

    const logsResponse = await webServer.inject({
      method: 'GET',
      url: `/api/runs/${run.lastInsertId}/logs`,
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
    });
    const logs = logsResponse.json() as { items: Array<{ event: string; message: string }> };
    expect(logs.items.some((item) => (
      item.event === 'crawl_error' && item.message.includes('no active worker')
    ))).toBe(true);
    await db.close();
  });

  it('stores a default site and exports pages by run id', async () => {
    const dir = createTempDir('kvault-web-simple-');
    const dbPath = join(dir, 'state.db');
    const webServer = await createWebServer({
      dbPath,
      adminPassword: 'secret',
      maxConcurrentRuns: 2,
      apiKey: 'external-secret',
    });
    servers.push(webServer);
    const authCookie = await login(webServer);

    const db = await openDatabase(dbPath);
    const now = new Date().toISOString();
    const config = {
      seedUrls: [],
      sitemaps: [],
      rulesBeforeBaseEq: [],
      rulesBeforeStage2Eq: [],
      runOptions: {
        seedMaxDepth: 1,
        crawlMaxDepth: 0,
      },
    };
    const project = await db.run(
      'INSERT INTO projects (name, slug, label_definitions_json, created_at) VALUES (?, ?, ?, ?)',
      ['Simple Project', 'simple-project', '[]', now],
    );
    const site = await db.run(
      `INSERT INTO sites (
        project_id, name, base_url, storage_root, config_json, updated_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        project.lastInsertId,
        'simple-site',
        'https://example.com',
        join(dir, 'storage'),
        JSON.stringify(config),
        now,
        now,
      ],
    );
    const run = await db.run(
      `INSERT INTO crawl_runs (
        site_id, run_type, update_policy, config_snapshot_json, status, started_at, finished_at,
        successful_page_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        site.lastInsertId,
        'crawl_run',
        'force_recrawl_all',
        JSON.stringify(config),
        'succeeded',
        now,
        now,
        1,
      ],
    );
    const page = await db.run(
      `INSERT INTO site_pages (
        site_id, discovered_url, normalized_url, inventory_status, discovery_source,
        last_base_status, last_base_run_id, last_base_at,
        last_markdown_status, last_markdown_run_id, last_markdown_at,
        latest_title, first_discovered_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        site.lastInsertId,
        'https://example.com/page',
        'https://example.com/page',
        'stage2_captured',
        'inventory',
        'succeeded',
        run.lastInsertId,
        now,
        'succeeded',
        run.lastInsertId,
        now,
        'Simple page',
        now,
        now,
        now,
      ],
    );
    const pageRun = await db.run(
      `INSERT INTO page_runs (
        crawl_run_id, site_page_id, started_at, finished_at, base_capture_status,
        title, meta_description, body_text, classification_labels_json, rule_outcome,
        decision_outcome, required_artifacts_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.lastInsertId,
        page.lastInsertId,
        now,
        now,
        'succeeded',
        'Simple page',
        '',
        'Base body',
        '{}',
        'allow',
        'allow',
        '["markdown"]',
      ],
    );
    await db.run(
      `INSERT INTO artifact_runs (
        crawl_run_id, page_run_id, site_page_id, artifact_type, status,
        started_at, finished_at, output_path, content, error_message, meta_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.lastInsertId,
        pageRun.lastInsertId,
        page.lastInsertId,
        'markdown',
        'succeeded',
        now,
        now,
        null,
        '# Simple page\n\nMarkdown body',
        null,
        '{"tool":"test"}',
      ],
    );

    const setDefaultResponse = await webServer.inject({
      method: 'PUT',
      url: '/api/system/default-site',
      headers: {
        'x-api-key': 'external-secret',
      },
      payload: {
        siteId: site.lastInsertId,
      },
    });
    expect(setDefaultResponse.statusCode).toBe(403);

    const sessionSetDefaultResponse = await webServer.inject({
      method: 'PUT',
      url: '/api/system/default-site',
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
      payload: {
        siteId: site.lastInsertId,
      },
    });
    expect(sessionSetDefaultResponse.statusCode).toBe(200);
    expect((sessionSetDefaultResponse.json() as { defaultSite: { siteId: number } }).defaultSite.siteId)
      .toBe(site.lastInsertId);

    const pageIdsResponse = await webServer.inject({
      method: 'GET',
      url: `/api/runs/${run.lastInsertId}/page-ids`,
      headers: {
        'x-api-key': 'external-secret',
      },
    });
    expect(pageIdsResponse.statusCode).toBe(200);
    expect((pageIdsResponse.json() as { pageIds: number[] }).pageIds).toEqual([page.lastInsertId]);

    const runExportResponse = await webServer.inject({
      method: 'POST',
      url: `/api/runs/${run.lastInsertId}/export`,
      headers: {
        authorization: 'Bearer external-secret',
      },
      payload: {
        artifacts: ['markdown'],
      },
    });
    expect(runExportResponse.statusCode).toBe(200);
    expect(runExportResponse.headers['content-type']).toContain('application/zip');
    expect(runExportResponse.rawPayload.length).toBeGreaterThan(0);

    const simpleDownloadResponse = await webServer.inject({
      method: 'GET',
      url: `/api/simple-capture/runs/${run.lastInsertId}/download`,
      headers: {
        'x-api-key': 'external-secret',
      },
    });
    expect(simpleDownloadResponse.statusCode).toBe(200);
    expect(simpleDownloadResponse.headers['content-type']).toContain('application/zip');
    await db.close();
  });

  it('submits simple capture runs with multiple URLs', async () => {
    const dir = createTempDir('kvault-web-simple-capture-urls-');
    const dbPath = join(dir, 'state.db');
    const webServer = await createWebServer({
      dbPath,
      adminPassword: 'secret',
      maxConcurrentRuns: 1,
      apiKey: 'external-secret',
    });
    servers.push(webServer);

    const siteServer = await startTestSiteServer();
    siteServers.push(siteServer);

    const db = await openDatabase(dbPath);
    const now = new Date().toISOString();
    const config = {
      seedUrls: [],
      sitemaps: [],
      rulesBeforeBaseEq: [],
      rulesBeforeStage2Eq: [],
      runOptions: {
        seedMaxDepth: 1,
        crawlMaxDepth: 0,
      },
    };
    const project = await db.run(
      'INSERT INTO projects (name, slug, label_definitions_json, created_at) VALUES (?, ?, ?, ?)',
      ['Simple Project', 'simple-project', '[]', now],
    );
    const site = await db.run(
      `INSERT INTO sites (
        project_id, name, base_url, storage_root, config_json, updated_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        project.lastInsertId,
        'simple-site',
        siteServer.baseUrl,
        join(dir, 'storage'),
        JSON.stringify(config),
        now,
        now,
      ],
    );

    const authCookie = await login(webServer);
    const setDefaultResponse = await webServer.inject({
      method: 'PUT',
      url: '/api/system/default-site',
      cookies: {
        kvault_session: authCookie.split('=')[1],
      },
      payload: {
        siteId: site.lastInsertId,
      },
    });
    expect(setDefaultResponse.statusCode).toBe(200);

    const singleUrlResponse = await webServer.inject({
      method: 'POST',
      url: '/api/simple-capture/runs',
      headers: {
        'x-api-key': 'external-secret',
      },
      payload: {
        url: `${siteServer.baseUrl}/docs`,
      },
    });
    expect(singleUrlResponse.statusCode).toBe(400);

    const submitResponse = await webServer.inject({
      method: 'POST',
      url: '/api/simple-capture/runs',
      headers: {
        'x-api-key': 'external-secret',
      },
      payload: {
        urls: [
          `${siteServer.baseUrl}/docs`,
          `${siteServer.baseUrl}/product`,
        ],
      },
    });
    expect(submitResponse.statusCode).toBe(200);
    const submitted = submitResponse.json() as { siteId: number };
    expect(submitted.siteId).toBe(site.lastInsertId);

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const row = await db.get<{ page_count: number }>(
        'SELECT COUNT(*) AS page_count FROM site_pages WHERE site_id = ?',
        [site.lastInsertId],
      );
      if ((row?.page_count ?? 0) >= 2) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const pages = await db.all<{ normalized_url: string }>(
      'SELECT normalized_url FROM site_pages WHERE site_id = ? ORDER BY normalized_url',
      [site.lastInsertId],
    );
    expect(pages.map((page) => page.normalized_url)).toEqual([
      `${siteServer.baseUrl}/docs`,
      `${siteServer.baseUrl}/product`,
    ]);

    await db.close();
  });
});
