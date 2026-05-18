import 'dotenv/config';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import Fastify, { type FastifyInstance } from 'fastify';

import { M1App } from '../app/services.js';
import type { ProjectExportArtifact, ProjectExportOptions } from '../export/project-exporter.js';
import { openDatabase } from '../db/database.js';
import { chatCompletion, type ChatCompletionMessageParam } from '../utils/llm_chat.js';
import { fetchAndRenderPrompt } from '../utils/llm_prompts.js';
import { SessionAuth } from './auth/session-auth.js';
import {
  PendingReviewQuery,
  ProjectListQuery,
  RunLogQuery,
  RunSummaryQuery,
  SitePageDetailQuery,
  SiteOverviewQuery,
  SitePageListQuery,
} from './queries/read-models.js';
import { buildBaseEnqueueDecision, buildStage2EnqueueDecision } from '../rules/rule-decision.js';
import { mapConfigFormToSiteConfig, mapRunForm } from './services/config-mapper.js';
import { RunCoordinator } from './services/run-coordinator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const frontendDir = join(__dirname, 'frontend/dist');
const textAssetCache = new Map<string, Promise<string>>();
const binaryAssetCache = new Map<string, Promise<Buffer>>();
const DEFAULT_EVENT_LOOP_DELAY_INTERVAL_MS = 5000;
const DEFAULT_EVENT_LOOP_DELAY_THRESHOLD_MS = 100;
const EXPORT_DOWNLOAD_TTL_MS = 1000 * 60 * 60;

interface EventLoopDelaySnapshot {
  intervalMs: number;
  thresholdMs: number;
  minMs: number;
  meanMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  activeRunCount: number;
  createdAt: string;
}

interface EventLoopDelayMonitorHandle {
  getSnapshot(): EventLoopDelaySnapshot | null;
  close(): void;
}

interface PreparedExport {
  outputPath: string;
  fileName: string;
  expiresAt: number;
}

function parseSiteId(value: string): number {
  const siteId = Number(value);

  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error('siteId 无效。');
  }

  return siteId;
}

function parseStatusFilter(value: string | string[] | undefined): string[] | undefined {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const statuses = values
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter(Boolean);
  return statuses.length > 0 ? statuses : undefined;
}

function parseProjectId(value: string): number {
  const projectId = Number(value);

  if (!Number.isInteger(projectId) || projectId <= 0) {
    throw new Error('projectId 无效。');
  }

  return projectId;
}

function parseRunId(value: string): number {
  const runId = Number(value);

  if (!Number.isInteger(runId) || runId <= 0) {
    throw new Error('runId 无效。');
  }

  return runId;
}

function parseSitePageId(value: string): number {
  const sitePageId = Number(value);

  if (!Number.isInteger(sitePageId) || sitePageId <= 0) {
    throw new Error('sitePageId 无效。');
  }

  return sitePageId;
}

function parseArtifactRunId(value: string): number {
  const artifactRunId = Number(value);

  if (!Number.isInteger(artifactRunId) || artifactRunId <= 0) {
    throw new Error('artifactRunId 无效。');
  }

  return artifactRunId;
}

function parseProjectExportOptions(value: unknown): ProjectExportOptions {
  if (typeof value !== 'object' || value === null) {
    return {};
  }

  const record = value as Record<string, unknown>;
  const siteIds = Array.isArray(record.siteIds)
    ? record.siteIds
        .map((siteId) => typeof siteId === 'number' ? siteId : Number(siteId))
        .filter((siteId) => Number.isInteger(siteId) && siteId > 0)
    : undefined;
  const allowedArtifacts = new Set<ProjectExportArtifact>(['base', 'markdown', 'screenshot']);
  const artifacts = Array.isArray(record.artifacts)
    ? record.artifacts.filter((artifact): artifact is ProjectExportArtifact => (
        typeof artifact === 'string' && allowedArtifacts.has(artifact as ProjectExportArtifact)
      ))
    : undefined;
  const includeDeniedPages = typeof record.includeDeniedPages === 'boolean'
    ? record.includeDeniedPages
    : undefined;

  return {
    ...(siteIds ? { siteIds } : {}),
    ...(artifacts ? { artifacts } : {}),
    ...(includeDeniedPages !== undefined ? { includeDeniedPages } : {}),
  };
}

function parseLlmHistory(value: unknown): ChatCompletionMessageParam[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((message): message is { role: 'user' | 'assistant'; content: string } => {
      if (typeof message !== 'object' || message === null) {
        return false;
      }
      const record = message as Record<string, unknown>;
      return (
        (record.role === 'user' || record.role === 'assistant') &&
        typeof record.content === 'string' &&
        record.content.trim().length > 0
      );
    })
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
}

function artifactContentType(path: string, artifactType: string): string {
  if (artifactType !== 'screenshot') {
    return 'text/plain; charset=utf-8';
  }

  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}

function readFrontendAsset(name: string): Promise<string> {
  const cached = textAssetCache.get(name);
  if (cached) {
    return cached;
  }

  const pending = readFile(join(frontendDir, name), 'utf8');
  textAssetCache.set(name, pending);
  return pending;
}

function readFrontendBinaryAsset(name: string): Promise<Buffer> {
  const cached = binaryAssetCache.get(name);
  if (cached) {
    return cached;
  }

  const pending = readFile(join(frontendDir, 'assets', name));
  binaryAssetCache.set(name, pending);
  return pending;
}

function nanosecondsToMs(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Number((value / 1_000_000).toFixed(2));
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function startEventLoopDelayMonitor(input: {
  intervalMs: number;
  thresholdMs: number;
  getActiveRunCount: () => number;
}): EventLoopDelayMonitorHandle {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  let latestSnapshot: EventLoopDelaySnapshot | null = null;

  histogram.enable();

  const interval = setInterval(() => {
    const activeRunCount = input.getActiveRunCount();
    const snapshot: EventLoopDelaySnapshot = {
      intervalMs: input.intervalMs,
      thresholdMs: input.thresholdMs,
      minMs: nanosecondsToMs(histogram.min),
      meanMs: nanosecondsToMs(histogram.mean),
      maxMs: nanosecondsToMs(histogram.max),
      p50Ms: nanosecondsToMs(histogram.percentile(50)),
      p95Ms: nanosecondsToMs(histogram.percentile(95)),
      p99Ms: nanosecondsToMs(histogram.percentile(99)),
      activeRunCount,
      createdAt: new Date().toISOString(),
    };

    latestSnapshot = snapshot;

    if (activeRunCount > 0 || snapshot.p99Ms >= input.thresholdMs) {
      const log = snapshot.p99Ms >= input.thresholdMs ? console.warn : console.info;
      log('[web] event_loop_delay', snapshot);
    }

    histogram.reset();
  }, input.intervalMs);

  interval.unref?.();

  return {
    getSnapshot: () => latestSnapshot,
    close: () => {
      clearInterval(interval);
      histogram.disable();
    },
  };
}

async function waitForLatestRun(
  runQuery: RunSummaryQuery,
  siteId: number,
  runType: 'seed_run' | 'crawl_run',
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const latestRun = await runQuery.getLatestRunForSite(siteId, runType);
    if (latestRun) {
      return latestRun;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  return null;
}

export interface WebServerOptions {
  dbPath: string;
  databaseUrl?: string;
  adminPassword: string;
  port?: number;
  host?: string;
  maxConcurrentRuns?: number;
  sessionTtlMs?: number;
  eventLoopDelayMonitorIntervalMs?: number;
  eventLoopDelayWarningThresholdMs?: number;
}

export async function createWebServer(options: WebServerOptions): Promise<FastifyInstance> {
  const server = Fastify({
    logger: false,
  });
  const app = await M1App.create({ dbPath: options.dbPath, databaseUrl: options.databaseUrl });
  const queryDb = await openDatabase({ path: options.dbPath, url: options.databaseUrl });
  const auth = new SessionAuth(options.adminPassword, options.sessionTtlMs ?? 1000 * 60 * 60 * 8);
  const coordinator = new RunCoordinator(options.maxConcurrentRuns ?? 2);
  const projectQuery = new ProjectListQuery(queryDb);
  const siteOverviewQuery = new SiteOverviewQuery(queryDb);
  const sitePageQuery = new SitePageListQuery(queryDb);
  const sitePageDetailQuery = new SitePageDetailQuery(queryDb);
  const runQuery = new RunSummaryQuery(queryDb);
  const runLogQuery = new RunLogQuery(queryDb);
  const pendingReviewQuery = new PendingReviewQuery(queryDb);
  const eventLoopDelayMonitor = startEventLoopDelayMonitor({
    intervalMs:
      options.eventLoopDelayMonitorIntervalMs ??
      parsePositiveNumber(
        process.env.KVAULT_EVENT_LOOP_DELAY_INTERVAL_MS,
        DEFAULT_EVENT_LOOP_DELAY_INTERVAL_MS,
      ),
    thresholdMs:
      options.eventLoopDelayWarningThresholdMs ??
      parsePositiveNumber(
        process.env.KVAULT_EVENT_LOOP_DELAY_THRESHOLD_MS,
        DEFAULT_EVENT_LOOP_DELAY_THRESHOLD_MS,
      ),
    getActiveRunCount: () => coordinator.listActiveRuns().length,
  });
  const preparedExports = new Map<string, PreparedExport>();

  const rememberPreparedExport = (result: { outputPath: string; fileName: string }): string => {
    const token = randomUUID();
    const now = Date.now();

    for (const [key, value] of preparedExports) {
      if (value.expiresAt <= now) {
        preparedExports.delete(key);
      }
    }

    preparedExports.set(token, {
      outputPath: result.outputPath,
      fileName: result.fileName,
      expiresAt: now + EXPORT_DOWNLOAD_TTL_MS,
    });

    return token;
  };

  await auth.register(server);

  server.addHook('onClose', async () => {
    eventLoopDelayMonitor.close();
    await app.close();
    await queryDb.close();
  });

  server.setErrorHandler((error, _request, reply) => {
    const statusCode = reply.statusCode >= 400 ? reply.statusCode : 400;
    reply.code(statusCode).send({
      message: error instanceof Error ? error.message : '请求失败。',
    });
  });

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

  server.post('/api/projects/:projectId/export', async (request, reply) => {
    const params = request.params as { projectId: string };
    const result = await app.exportProject(
      parseProjectId(params.projectId),
      undefined,
      parseProjectExportOptions(request.body),
    );
    const fileStat = await stat(result.outputPath);
    return reply
      .type('application/zip')
      .header('Content-Disposition', `attachment; filename="${result.fileName}"`)
      .header('Content-Length', fileStat.size)
      .send(createReadStream(result.outputPath));
  });

  server.post('/api/projects/:projectId/export/prepare', async (request) => {
    const params = request.params as { projectId: string };
    const result = await app.exportProject(
      parseProjectId(params.projectId),
      undefined,
      parseProjectExportOptions(request.body),
    );
    const token = rememberPreparedExport(result);

    return {
      token,
      fileName: result.fileName,
      expiresInSeconds: Math.floor(EXPORT_DOWNLOAD_TTL_MS / 1000),
    };
  });

  server.get('/api/projects/:projectId/export/download/:token', async (request, reply) => {
    const params = request.params as { projectId: string; token: string };
    parseProjectId(params.projectId);

    const prepared = preparedExports.get(params.token);
    if (!prepared || prepared.expiresAt <= Date.now()) {
      preparedExports.delete(params.token);
      reply.code(404);
      throw new Error('导出文件已过期，请重新导出。');
    }

    const fileStat = await stat(prepared.outputPath);
    return reply
      .type('application/zip')
      .header('Content-Disposition', `attachment; filename="${prepared.fileName}"`)
      .header('Content-Length', fileStat.size)
      .header('Cache-Control', 'no-store')
      .send(createReadStream(prepared.outputPath));
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
    void coordinator.startSeed(app, {
      siteId,
      targetSuccessCount: input.targetSuccessCount,
    }).catch(() => { });
    const latestRun = await waitForLatestRun(runQuery, siteId, 'seed_run');

    if (!latestRun) {
      reply.code(500);
      throw new Error('未能创建初步摸底任务。');
    }

    return {
      runId: latestRun.runId,
      statusLabel: '进行中',
    };
  });

  server.post('/api/sites/:siteId/runs/crawl', async (request, reply) => {
    const params = request.params as { siteId: string };
    const siteId = parseSiteId(params.siteId);
    const input = mapRunForm((request.body ?? {}) as Record<string, unknown>);
    void coordinator.startCrawl(app, {
      siteId,
      ...input,
    }).catch(() => { });
    const latestRun = await waitForLatestRun(runQuery, siteId, 'crawl_run');

    if (!latestRun) {
      reply.code(500);
      throw new Error('未能创建正式采集任务。');
    }

    return {
      runId: latestRun.runId,
      statusLabel: '进行中',
    };
  });

  server.get('/api/sites/:siteId/runs', async (request) => {
    const params = request.params as { siteId: string };
    return {
      items: await runQuery.listSiteRuns(parseSiteId(params.siteId)),
    };
  });

  server.get('/api/runs/:runId', async (request) => {
    const params = request.params as { runId: string };
    return runQuery.getRunSummary(parseRunId(params.runId));
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

  server.get('/api/sites/:siteId/pages/export', async (request, reply) => {
    const params = request.params as { siteId: string };
    const query = request.query as Record<string, string | string[] | undefined>;
    const crawlRunId = typeof query.crawlRunId === 'string' ? Number(query.crawlRunId) : undefined;

    if (crawlRunId !== undefined && (!Number.isInteger(crawlRunId) || crawlRunId <= 0)) {
      throw new Error('crawlRunId 无效。');
    }

    const result = await app.exportSitePageList({
      siteId: parseSiteId(params.siteId),
      status: parseStatusFilter(query.status),
      query: typeof query.query === 'string' ? query.query : undefined,
      label: typeof query.label === 'string' ? query.label : undefined,
      pendingReason: typeof query.pendingReason === 'string' ? query.pendingReason : undefined,
      discoverySource: typeof query.discoverySource === 'string' ? query.discoverySource : undefined,
      crawlRunId,
    });
    const fileStat = await stat(result.outputPath);

    return reply
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${result.fileName}"`)
      .header('Content-Length', fileStat.size)
      .send(createReadStream(result.outputPath));
  });

  server.get('/api/sites/:siteId/pages/:sitePageId', async (request) => {
    const params = request.params as { siteId: string; sitePageId: string };
    return sitePageDetailQuery.getPageDetail(
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

  return server;
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? '3100');
  const host = process.env.HOST ?? '127.0.0.1';
  const dbPath = process.env.KVAULT_DB_PATH ?? '.local/state.db';
  const databaseUrl = process.env.KVAULT_DATABASE_URL;
  const adminPassword = process.env.KVAULT_ADMIN_PASSWORD ?? 'kvault-dev';
  const server = await createWebServer({
    dbPath,
    databaseUrl,
    adminPassword,
    host,
    port,
  });

  await server.listen({
    host,
    port,
  });
  console.log(`Web UI listening on http://${host}:${port}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
