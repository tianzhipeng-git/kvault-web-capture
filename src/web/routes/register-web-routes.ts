import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { CaptureApp } from '../../app/capture-app.js';
import { buildBaseEnqueueDecision, buildStage2EnqueueDecision } from '../../rules/rule-decision.js';
import { chatCompletion, type ChatCompletionMessageParam } from '../../utils/llm_chat.js';
import { fetchAndRenderPrompt } from '../../utils/llm_prompts.js';
import { expandLinks } from '../../utils/link-expander.js';
import type { SessionAuth } from '../auth/session-auth.js';
import { ExportDownloadStore, sendZipFile } from '../http/export-downloads.js';
import { parsePositiveNumber, type EventLoopDelayMonitorHandle } from '../http/event-loop-delay-monitor.js';
import { readFrontendAsset, readFrontendBinaryAsset } from '../http/frontend-assets.js';
import {
  artifactContentType,
  parseArtifactRunId,
  parseExportArtifacts,
  parseLlmHistory,
  parseOptionalSiteId,
  parsePageIdList,
  parseProjectExportOptions,
  parseProjectId,
  parseRunId,
  parseRunType,
  parseSimpleCaptureUrls,
  parseSiteId,
  parseSitePageId,
  parseSitePageListExportInput,
  parseStatusFilter,
} from '../http/input-parsers.js';
import type {
  PendingReviewQuery,
  ProjectListQuery,
  RunLogQuery,
  RunSummaryQuery,
  SitePageDetailQuery,
  SiteOverviewQuery,
  SitePageListQuery,
} from '../queries/read-models.js';
import { mapConfigFormToSiteConfig, mapRunForm } from '../services/config-mapper.js';
import type { RunCoordinator } from '../services/run-coordinator.js';

interface RegisterWebRoutesOptions {
  server: FastifyInstance;
  app: CaptureApp;
  auth: SessionAuth;
  coordinator: RunCoordinator;
  projectQuery: ProjectListQuery;
  siteOverviewQuery: SiteOverviewQuery;
  sitePageQuery: SitePageListQuery;
  sitePageDetailQuery: SitePageDetailQuery;
  runQuery: RunSummaryQuery;
  runLogQuery: RunLogQuery;
  pendingReviewQuery: PendingReviewQuery;
  eventLoopDelayMonitor: Pick<EventLoopDelayMonitorHandle, 'getSnapshot'>;
  exportDownloads: ExportDownloadStore;
}

async function waitForLatestRun(
  runQuery: RunSummaryQuery,
  siteId: number,
  runType: 'seed_run' | 'crawl_run',
  minRunIdExclusive = 0,
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const latestRun = await runQuery.getLatestRunForSite(siteId, runType);
    if (latestRun && latestRun.runId > minRunIdExclusive) {
      return latestRun;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  return null;
}

export function registerWebRoutes(options: RegisterWebRoutesOptions): void {
  const {
    server,
    app,
    auth,
    coordinator,
    projectQuery,
    siteOverviewQuery,
    sitePageQuery,
    sitePageDetailQuery,
    runQuery,
    runLogQuery,
    pendingReviewQuery,
    eventLoopDelayMonitor,
    exportDownloads,
  } = options;

  const requireDefaultSite = async () => {
    const defaultSite = await app.getDefaultSite();

    if (!defaultSite) {
      throw new Error('系统还没有配置默认站点。');
    }

    return defaultSite;
  };

  const buildSimpleCaptureInput = async (body: Record<string, unknown>) => {
    const defaultSite = await requireDefaultSite();
    const runInput = mapRunForm(body);
    return {
      defaultSite,
      runInput: {
        siteId: defaultSite.siteId,
        updatePolicy: runInput.updatePolicy,
        targetSuccessCount: runInput.targetSuccessCount,
        staleAfterMs: runInput.staleAfterMs,
        initialUrls: parseSimpleCaptureUrls(body.urls),
        crawlMaxDepthOverride: 0,
      },
    };
  };

  const requireSessionAuth = (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    if (request.authSource !== 'session') {
      reply.code(403);
      throw new Error('该接口仅允许 Web UI 登录态访问。');
    }
  };

  server.get('/health', async () => ({
    status: 'ok',
    activeRuns: coordinator.listActiveRuns(),
    eventLoopDelay: eventLoopDelayMonitor.getSnapshot(),
  }));

  server.setNotFoundHandler(async (request, reply) => {
    if (request.method === 'GET' && !request.url.startsWith('/api/')) {
      reply.type('text/html; charset=utf-8').send(await readFrontendAsset('index.html'));
      return;
    }
    reply.code(404).send({ message: 'Not found' });
  });

  server.get('/', async (_request, reply) => {
    reply.type('text/html; charset=utf-8').send(await readFrontendAsset('index.html'));
  });

  server.get('/app.js', async (_request, reply) => {
    reply.type('application/javascript; charset=utf-8').send(await readFrontendAsset('app.js'));
  });

  server.get('/styles.css', async (_request, reply) => {
    reply.type('text/css; charset=utf-8').send(await readFrontendAsset('styles.css'));
  });

  server.get('/assets/:file', async (request, reply) => {
    const params = request.params as { file: string };
    try {
      reply.send(await readFrontendBinaryAsset(params.file));
    } catch {
      reply.code(404).send('Not found');
    }
  });

  server.post('/api/auth/login', async (request, reply) => {
    const body = (request.body ?? {}) as { password?: string };
    auth.login(request, reply, body.password ?? '');
    return {
      authenticated: true,
    };
  });

  server.post('/api/auth/logout', async (request, reply) => {
    auth.logout(request, reply);
    return {
      authenticated: false,
    };
  });

  server.get('/api/auth/session', async (request) => auth.getSessionState(request));

  server.post('/api/links/expand', async (request, reply) => {
    requireSessionAuth(request, reply);
    const body = (request.body ?? {}) as { url?: string };
    if (!body.url?.trim()) {
      reply.code(400);
      throw new Error('URL 不能为空。');
    }
    return expandLinks(body.url.trim());
  });

  server.post('/api/llm/chat', async (request, reply) => {
    const body = (request.body ?? {}) as {
      promptName?: string;
      promptVersion?: string;
      context?: Record<string, unknown>;
      history?: unknown;
      model?: string;
      temperature?: number;
      responseFormat?: 'json_object' | 'text';
    };

    if (!body.promptName?.trim()) {
      reply.code(400);
      throw new Error('promptName 不能为空。');
    }

    const renderedMessages = await fetchAndRenderPrompt(
      body.promptName.trim(),
      body.promptVersion,
      body.context ?? {},
    );
    const systemMessages = renderedMessages.filter((message) => message.role === 'system');
    const promptMessages = renderedMessages.filter((message) => message.role !== 'system');
    const messages = [
      ...(systemMessages as ChatCompletionMessageParam[]),
      ...(promptMessages as ChatCompletionMessageParam[]),
      ...parseLlmHistory(body.history),
    ];
    const content = await chatCompletion(messages, {
      model: body.model,
      temperature: body.temperature,
      response_format:
        body.responseFormat === 'json_object'
          ? { type: 'json_object' }
          : undefined,
    });

    return {
      content,
    };
  });

  server.get('/api/system/default-site', async (request, reply) => {
    requireSessionAuth(request, reply);
    return {
      defaultSite: await app.getDefaultSite(),
    };
  });

  server.put('/api/system/default-site', async (request, reply) => {
    requireSessionAuth(request, reply);
    const body = (request.body ?? {}) as { siteId?: unknown };
    await app.setDefaultSite(parseOptionalSiteId(body.siteId));
    return {
      status: 'ok',
      defaultSite: await app.getDefaultSite(),
    };
  });

  server.get('/api/system/config', async (request, reply) => {
    requireSessionAuth(request, reply);
    return {
      config: await app.getSystemConfig(),
    };
  });

  server.put('/api/system/url-normalization', async (request, reply) => {
    requireSessionAuth(request, reply);
    const body = (request.body ?? {}) as {
      stripQueryParams?: unknown;
      stripQueryParamPrefixes?: unknown;
    };
    const asStringArray = (value: unknown, fieldName: string): string[] => {
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        throw new Error(`${fieldName} must be an array of strings`);
      }
      return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
    };
    const config = await app.updateSystemUrlNormalization({
      stripQueryParams: asStringArray(body.stripQueryParams ?? [], 'stripQueryParams'),
      stripQueryParamPrefixes: asStringArray(body.stripQueryParamPrefixes ?? [], 'stripQueryParamPrefixes'),
    });
    return {
      status: 'ok',
      config,
    };
  });

  server.post('/api/simple-capture/runs', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const { defaultSite, runInput } = await buildSimpleCaptureInput(body);
    const latestBefore = await runQuery.getLatestRunForSite(defaultSite.siteId, 'crawl_run');
    void coordinator.startCrawl(app, runInput).catch(() => { });
    const latestRun = await waitForLatestRun(
      runQuery,
      defaultSite.siteId,
      'crawl_run',
      latestBefore?.runId ?? 0,
    );

    if (!latestRun) {
      reply.code(500);
      throw new Error('未能创建简易采集任务。');
    }

    coordinator.attachRunId(defaultSite.siteId, latestRun.runId);

    return {
      runId: latestRun.runId,
      siteId: defaultSite.siteId,
      statusLabel: latestRun.statusLabel,
    };
  });

  server.get('/api/simple-capture/runs/:runId', async (request) => {
    const params = request.params as { runId: string };
    return runQuery.getRunSummary(parseRunId(params.runId));
  });

  server.get('/api/simple-capture/runs/:runId/download', async (request, reply) => {
    const params = request.params as { runId: string };
    return sendZipFile(reply, await app.exportRunPages(parseRunId(params.runId)));
  });

  server.post('/api/simple-capture/submit-and-download', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const { defaultSite, runInput } = await buildSimpleCaptureInput(body);
    const summary = await coordinator.startCrawl(app, runInput);
    reply
      .header('X-Kvault-Run-Id', String(summary.runId))
      .header('X-Kvault-Site-Id', String(defaultSite.siteId));
    return sendZipFile(reply, await app.exportRunPages(summary.runId));
  });

  server.post('/api/simple-capture/submit-markdown', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const { defaultSite, runInput } = await buildSimpleCaptureInput(body);
    const summary = await coordinator.startCrawl(app, runInput);
    const result = await runQuery.getRunMarkdown(summary.runId);
    return reply
      .type('text/markdown; charset=utf-8')
      .header('X-Kvault-Run-Id', String(result.runId))
      .header('X-Kvault-Site-Id', String(defaultSite.siteId))
      .header('X-Kvault-Page-Count', String(result.pageCount))
      .send(result.markdown);
  });

  server.get('/api/projects', async () => ({
    items: await projectQuery.listProjects(),
  }));

  server.post('/api/projects', async (request, reply) => {
    const body = (request.body ?? {}) as { name?: string };

    if (!body.name?.trim()) {
      reply.code(400);
      throw new Error('项目名称不能为空。');
    }

    return app.createProject(body.name.trim());
  });

  server.delete('/api/projects/:projectId', async (request, reply) => {
    const params = request.params as { projectId: string };
    const projectId = parseProjectId(params.projectId);
    const summary = await app.getProjectDeletionSummary(projectId);

    for (const site of summary.sites) {
      if (coordinator.isSiteBusy(site.siteId)) {
        reply.code(409);
        throw new Error(`站点「${site.siteName}」有运行中的任务，请先停止后再删除。`);
      }
    }

    await app.deleteProject(projectId);
    return { status: 'ok' };
  });

  server.get('/api/projects/:projectId/sites', async (request) => {
    const params = request.params as { projectId: string };
    return {
      items: await projectQuery.listSites(parseProjectId(params.projectId)),
    };
  });

  server.get('/api/projects/:projectId/label-definitions', async (request) => {
    const params = request.params as { projectId: string };
    return {
      labelDefinitions: await app.getProjectLabelDefinitions(parseProjectId(params.projectId)),
    };
  });

  server.put('/api/projects/:projectId/label-definitions', async (request) => {
    const params = request.params as { projectId: string };
    const body = (request.body ?? {}) as { labelDefinitions?: unknown };
    const labelDefinitions = body.labelDefinitions ?? [];
    await app.updateProjectLabelDefinitions(parseProjectId(params.projectId), labelDefinitions);
    return {
      status: 'ok',
      labelDefinitions,
    };
  });

  server.get('/api/exports/download/:token', async (request, reply) => {
    const params = request.params as { token: string };
    return exportDownloads.sendPreparedExportDownload(reply, params.token);
  });

  server.post('/api/projects/:projectId/export/prepare', async (request) => {
    const params = request.params as { projectId: string };
    const result = await app.exportProject(
      parseProjectId(params.projectId),
      undefined,
      parseProjectExportOptions(request.body),
    );
    return exportDownloads.buildPreparedExportResponse(result);
  });

  server.delete('/api/sites/:siteId', async (request, reply) => {
    const params = request.params as { siteId: string };
    const siteId = parseSiteId(params.siteId);

    if (coordinator.isSiteBusy(siteId)) {
      reply.code(409);
      throw new Error('当前站点有运行中的任务，请先停止后再删除。');
    }

    await app.deleteSite(siteId);
    return { status: 'ok' };
  });

  server.post('/api/sites', async (request, reply) => {
    const body = (request.body ?? {}) as {
      projectId?: unknown;
      name?: string;
      baseUrl?: string;
      storageRoot?: string;
    };

    const projectId = typeof body.projectId === 'number'
      ? body.projectId
      : typeof body.projectId === 'string'
        ? Number(body.projectId)
        : NaN;

    if (!Number.isInteger(projectId) || projectId <= 0) {
      reply.code(400);
      throw new Error('需要提供所属项目。');
    }

    if (!body.name?.trim() || !body.baseUrl?.trim() || !body.storageRoot?.trim()) {
      reply.code(400);
      throw new Error('站点名称、基础网址和存储目录不能为空。');
    }

    return app.createSite({
      projectId,
      name: body.name.trim(),
      baseUrl: body.baseUrl.trim(),
      storageRoot: body.storageRoot.trim(),
    });
  });

  server.get('/api/sites/:siteId', async (request) => {
    const params = request.params as { siteId: string };
    return siteOverviewQuery.getSiteOverview(parseSiteId(params.siteId));
  });

  server.get('/api/sites/:siteId/config', async (request) => {
    const params = request.params as { siteId: string };
    return app.getSiteConfig(parseSiteId(params.siteId));
  });

  server.post('/api/sites/:siteId/favicon/fetch', async (request) => {
    const params = request.params as { siteId: string };
    return app.fetchSiteFavicon(parseSiteId(params.siteId));
  });

  server.get('/api/sites/:siteId/favicon.ico', async (request, reply) => {
    const params = request.params as { siteId: string };
    const favicon = await app.getSiteFavicon(parseSiteId(params.siteId));

    if (!favicon) {
      reply.code(404);
      throw new Error('该站点暂无 favicon。');
    }

    return reply
      .type(favicon.contentType)
      .header('Cache-Control', 'private, max-age=3600')
      .send(favicon.data);
  });

  server.put('/api/sites/:siteId/config', async (request) => {
    const params = request.params as { siteId: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const config = mapConfigFormToSiteConfig(body);
    await app.updateSiteConfig(parseSiteId(params.siteId), config);
    return {
      status: 'ok',
      config,
    };
  });

  server.post('/api/sites/:siteId/config/import', async (request) => {
    const params = request.params as { siteId: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const config = mapConfigFormToSiteConfig(body.config as Record<string, unknown>);
    await app.updateSiteConfig(parseSiteId(params.siteId), config);
    return {
      status: 'ok',
      config,
    };
  });

  server.post('/api/sites/:siteId/config/clone-from/:sourceSiteId', async (request) => {
    const params = request.params as { siteId: string; sourceSiteId: string };
    await app.cloneSiteConfig(parseSiteId(params.sourceSiteId), parseSiteId(params.siteId));
    return {
      status: 'ok',
      config: await app.getSiteConfig(parseSiteId(params.siteId)),
    };
  });

  server.post('/api/sites/:siteId/rules/preview', async (request) => {
    const params = request.params as { siteId: string };
    const body = (request.body ?? {}) as {
      url: string;
      labels?: Record<string, string[]>;
      rulesBeforeBaseEq?: unknown[];
      rulesBeforeStage2Eq?: unknown[];
    };

    const savedConfig = await app.getSiteConfig(parseSiteId(params.siteId));
    const siteConfig = {
      ...savedConfig,
      rulesBeforeBaseEq: (body.rulesBeforeBaseEq ?? savedConfig.rulesBeforeBaseEq) as typeof savedConfig.rulesBeforeBaseEq,
      rulesBeforeStage2Eq: (body.rulesBeforeStage2Eq ?? savedConfig.rulesBeforeStage2Eq) as typeof savedConfig.rulesBeforeStage2Eq,
    };

    const baseDecision = buildBaseEnqueueDecision({ url: body.url, siteConfig });
    const classification = body.labels && Object.keys(body.labels).length > 0 ? { labels: body.labels } : null;
    const stage2Decision = buildStage2EnqueueDecision({ runType: 'crawl_run', url: body.url, siteConfig, classification });

    return { baseDecision, stage2Decision };
  });

  server.post('/api/sites/:siteId/runs/seed', async (request, reply) => {
    const params = request.params as { siteId: string };
    const siteId = parseSiteId(params.siteId);
    const input = mapRunForm((request.body ?? {}) as Record<string, unknown>);
    const latestBefore = await runQuery.getLatestRunForSite(siteId, 'seed_run');
    void coordinator.startSeed(app, {
      siteId,
      targetSuccessCount: input.targetSuccessCount,
    }).catch(() => { });
    const latestRun = await waitForLatestRun(runQuery, siteId, 'seed_run', latestBefore?.runId ?? 0);

    if (!latestRun) {
      reply.code(500);
      throw new Error('未能创建初步摸底任务。');
    }

    coordinator.attachRunId(siteId, latestRun.runId);

    return {
      runId: latestRun.runId,
      statusLabel: '进行中',
    };
  });

  server.post('/api/sites/:siteId/runs/crawl', async (request, reply) => {
    const params = request.params as { siteId: string };
    const siteId = parseSiteId(params.siteId);
    const input = mapRunForm((request.body ?? {}) as Record<string, unknown>);
    const latestBefore = await runQuery.getLatestRunForSite(siteId, 'crawl_run');
    void coordinator.startCrawl(app, {
      siteId,
      ...input,
    }).catch(() => { });
    const latestRun = await waitForLatestRun(runQuery, siteId, 'crawl_run', latestBefore?.runId ?? 0);

    if (!latestRun) {
      reply.code(500);
      throw new Error('未能创建正式采集任务。');
    }

    coordinator.attachRunId(siteId, latestRun.runId);

    return {
      runId: latestRun.runId,
      statusLabel: '进行中',
    };
  });

  server.get('/api/sites/:siteId/runs', async (request) => {
    const params = request.params as { siteId: string };
    const query = request.query as { page?: string; pageSize?: string; runType?: string };
    return runQuery.listSiteRuns({
      siteId: parseSiteId(params.siteId),
      page: parsePositiveNumber(query.page, 1),
      pageSize: parsePositiveNumber(query.pageSize, 20),
      runType: parseRunType(query.runType),
    });
  });

  server.get('/api/runs/:runId', async (request) => {
    const params = request.params as { runId: string };
    return runQuery.getRunSummary(parseRunId(params.runId));
  });

  server.post('/api/runs/:runId/cancel', async (request, reply) => {
    const params = request.params as { runId: string };
    const runId = parseRunId(params.runId);

    if (coordinator.cancelRun(runId)) {
      return {
        runId,
        status: 'cancelling',
        statusLabel: '正在取消',
      };
    }

    if (await app.cancelOrphanRun(runId)) {
      return {
        runId,
        status: 'cancelled',
        statusLabel: '已取消',
      };
    }

    {
      reply.code(409);
      throw new Error('该运行不在当前进程中或已经结束，无法取消。');
    }
  });

  server.get('/api/runs/:runId/page-ids', async (request) => {
    const params = request.params as { runId: string };
    return runQuery.getRunPageIds(parseRunId(params.runId));
  });

  server.post('/api/runs/:runId/export/prepare', async (request) => {
    const params = request.params as { runId: string };
    const body = (request.body ?? {}) as { artifacts?: unknown };
    const result = await app.exportRunPages(
      parseRunId(params.runId),
      parseExportArtifacts(body.artifacts),
    );
    return exportDownloads.buildPreparedExportResponse(result);
  });

  server.post('/api/runs/:runId/export', async (request, reply) => {
    const params = request.params as { runId: string };
    const body = (request.body ?? {}) as { artifacts?: unknown };
    return sendZipFile(
      reply,
      await app.exportRunPages(parseRunId(params.runId), parseExportArtifacts(body.artifacts)),
    );
  });

  server.get('/api/runs/:runId/logs', async (request) => {
    const params = request.params as { runId: string };
    const query = request.query as { sitePageId?: string };
    const runId = parseRunId(params.runId);
    const sitePageId = query.sitePageId ? parseSitePageId(query.sitePageId) : undefined;
    return {
      items: await runLogQuery.listRunLogs(runId, sitePageId),
      errorMessage: await runLogQuery.getRunErrorMessage(runId),
    };
  });

  server.get('/api/runs/:runId/runtime-log', async (request, reply) => {
    const params = request.params as { runId: string };
    const query = request.query as { tail?: string };
    const runId = parseRunId(params.runId);
    const tail = query.tail === undefined ? 500 : Number(query.tail);

    if (!Number.isInteger(tail) || tail < 0 || tail > 5000) {
      reply.code(400);
      throw new Error('tail 参数无效。');
    }

    const runtimeLog = await runLogQuery.getRuntimeLog(runId, tail);

    if (!runtimeLog) {
      reply.code(404);
      throw new Error('该运行暂无 runtime log。');
    }

    return runtimeLog;
  });

  server.get('/api/sites/:siteId/overview', async (request) => {
    const params = request.params as { siteId: string };
    return siteOverviewQuery.getSiteOverview(parseSiteId(params.siteId));
  });

  server.get('/api/sites/:siteId/path-tree', async (request) => {
    const params = request.params as { siteId: string };
    return app.getSitePathTree(parseSiteId(params.siteId));
  });

  server.get('/api/sites/:siteId/pages', async (request) => {
    const params = request.params as { siteId: string };
    const query = request.query as Record<string, string | string[] | undefined>;
    const crawlRunId = typeof query.crawlRunId === 'string' ? Number(query.crawlRunId) : undefined;

    if (crawlRunId !== undefined && (!Number.isInteger(crawlRunId) || crawlRunId <= 0)) {
      throw new Error('crawlRunId 无效。');
    }

    return sitePageQuery.listPages({
      siteId: parseSiteId(params.siteId),
      page: Number(query.page ?? '1'),
      pageSize: Number(query.pageSize ?? '20'),
      status: parseStatusFilter(query.status),
      query: typeof query.query === 'string' ? query.query : undefined,
      label: typeof query.label === 'string' ? query.label : undefined,
      pendingReason: typeof query.pendingReason === 'string' ? query.pendingReason : undefined,
      discoverySource: typeof query.discoverySource === 'string' ? query.discoverySource : undefined,
      crawlRunId,
    });
  });

  server.post('/api/sites/:siteId/pages/export/prepare', async (request) => {
    const params = request.params as { siteId: string };
    const result = await app.exportSitePageList(
      parseSitePageListExportInput(parseSiteId(params.siteId), request.body),
    );
    return exportDownloads.buildPreparedExportResponse(result);
  });

  server.post('/api/sites/:siteId/pages/export-by-ids/prepare', async (request) => {
    const params = request.params as { siteId: string };
    const body = (request.body ?? {}) as { pageIds?: unknown; artifacts?: unknown };
    const result = await app.exportSitePagesByIds({
      siteId: parseSiteId(params.siteId),
      pageIds: parsePageIdList(body.pageIds),
      artifacts: parseExportArtifacts(body.artifacts),
    });
    return exportDownloads.buildPreparedExportResponse(result);
  });

  server.get('/api/sites/:siteId/pages/:sitePageId', async (request) => {
    const params = request.params as { siteId: string; sitePageId: string };
    return sitePageDetailQuery.getPageDetail(
      parseSiteId(params.siteId),
      parseSitePageId(params.sitePageId),
    );
  });

  server.post('/api/sites/:siteId/pages/:sitePageId/classification/preview', async (request) => {
    const params = request.params as { siteId: string; sitePageId: string };
    return app.previewPageClassification(
      parseSiteId(params.siteId),
      parseSitePageId(params.sitePageId),
    );
  });

  server.get('/api/sites/:siteId/artifacts/:artifactRunId/file', async (request, reply) => {
    const params = request.params as { siteId: string; artifactRunId: string };
    const artifact = await sitePageDetailQuery.getArtifactFile(
      parseSiteId(params.siteId),
      parseArtifactRunId(params.artifactRunId),
    );
    const fileStat = await stat(artifact.outputPath);

    return reply
      .type(artifactContentType(artifact.outputPath, artifact.artifactType))
      .header('Content-Length', fileStat.size)
      .send(createReadStream(artifact.outputPath));
  });

  server.get('/api/sites/:siteId/pending-review', async (request) => {
    const params = request.params as { siteId: string };
    return {
      items: await pendingReviewQuery.getPendingReview(parseSiteId(params.siteId)),
    };
  });

  server.get('/api/sites/:siteId/sample-captures', async (request) => {
    const params = request.params as { siteId: string };
    const query = request.query as Record<string, string | undefined>;
    return {
      items: await app.listSampleCaptures(
        parseSiteId(params.siteId),
        Number(query.limit ?? '5'),
      ),
    };
  });
}
