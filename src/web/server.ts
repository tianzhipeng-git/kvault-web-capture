import 'dotenv/config';
import { createReadStream, type ReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { CaptureApp } from '../app/capture-app.js';
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
import { expandLinks } from '../utils/link-expander.js';
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
  const allowedArtifacts = new Set<ProjectExportArtifact>(['base', 'markdown', 'screenshot', 'structured']);
  const artifacts = Array.isArray(record.artifacts)
    ? record.artifacts.filter((artifact): artifact is ProjectExportArtifact => (
        typeof artifact === 'string' && allowedArtifacts.has(artifact as ProjectExportArtifact)
      ))
    : undefined;
  const status = record.status === undefined
    ? undefined
    : parseStatusFilter(
      Array.isArray(record.status)
        ? record.status.map((item) => String(item))
        : String(record.status),
    );

  return {
    ...(siteIds ? { siteIds } : {}),
    ...(artifacts ? { artifacts } : {}),
    ...(status ? { status } : {}),
  };
}

function parseExportArtifacts(value: unknown): ProjectExportArtifact[] | undefined {
  const allowedArtifacts = new Set<ProjectExportArtifact>(['base', 'markdown', 'screenshot', 'structured']);
  return Array.isArray(value)
    ? value.filter((artifact): artifact is ProjectExportArtifact => (
        typeof artifact === 'string' && allowedArtifacts.has(artifact as ProjectExportArtifact)
      ))
    : undefined;
}

function exportContentType(fileName: string): string {
  if (fileName.endsWith('.xlsx')) {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }

  return 'application/zip';
}

function parseSitePageListExportInput(siteId: number, value: unknown) {
  const record = typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {};
  const crawlRunId = record.crawlRunId === undefined
    ? undefined
    : typeof record.crawlRunId === 'number'
      ? record.crawlRunId
      : Number(record.crawlRunId);

  if (crawlRunId !== undefined && (!Number.isInteger(crawlRunId) || crawlRunId <= 0)) {
    throw new Error('crawlRunId 无效。');
  }

  const status = record.status === undefined
    ? undefined
    : parseStatusFilter(
      Array.isArray(record.status)
        ? record.status.map((item) => String(item))
        : String(record.status),
    );

  return {
    siteId,
    status,
    query: typeof record.query === 'string' ? record.query : undefined,
    label: typeof record.label === 'string' ? record.label : undefined,
    pendingReason: typeof record.pendingReason === 'string' ? record.pendingReason : undefined,
    discoverySource: typeof record.discoverySource === 'string' ? record.discoverySource : undefined,
    crawlRunId,
  };
}

function parsePageIdList(value: unknown): number[] {
  const rawValues = Array.isArray(value) ? value : [];
  const pageIds = rawValues.map((pageId) => (
    typeof pageId === 'number' ? pageId : Number(pageId)
  ));

  if (pageIds.length === 0) {
    throw new Error('pageIds 不能为空。');
  }

  if (pageIds.some((pageId) => !Number.isInteger(pageId) || pageId <= 0)) {
    throw new Error('pageIds 中包含无效 ID。');
  }

  return pageIds;
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
  if (artifactType === 'structured') {
    return 'application/json; charset=utf-8';
  }

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

function parseOptionalSiteId(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const siteId = typeof value === 'number' ? value : Number(value);

  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error('siteId 无效。');
  }

  return siteId;
}

function parseSimpleCaptureUrls(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('urls 必须是非空 URL 数组。');
  }

  if (!value.every((item) => typeof item === 'string')) {
    throw new Error('urls 必须是字符串数组。');
  }

  const urls = [...new Set(value
    .map((item) => item.trim())
    .filter(Boolean))];

  if (urls.length === 0) {
    throw new Error('urls 不能为空。');
  }

  return urls;
}

export interface WebServerOptions {
  dbPath: string;
  databaseUrl?: string;
  adminPassword: string;
  port?: number;
  host?: string;
  maxConcurrentRuns?: number;
  sessionTtlMs?: number;
  apiKey?: string;
  eventLoopDelayMonitorIntervalMs?: number;
  eventLoopDelayWarningThresholdMs?: number;
}

export async function createWebServer(options: WebServerOptions): Promise<FastifyInstance> {
  const server = Fastify({
    logger: false,
  });
  const app = await CaptureApp.create({ dbPath: options.dbPath, databaseUrl: options.databaseUrl });
  const queryDb = await openDatabase({ path: options.dbPath, url: options.databaseUrl });
  const auth = new SessionAuth(
    options.adminPassword,
    options.sessionTtlMs ?? 1000 * 60 * 60 * 8,
    options.apiKey ?? process.env.KVAULT_API_KEY ?? null,
  );
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

  const removeExportFile = async (outputPath: string) => {
    try {
      await rm(outputPath, { force: true });
    } catch {
      // Export cleanup is best-effort; a failed delete must not fail the download response.
    }
  };

  const cleanupExpiredPreparedExports = async (now = Date.now()) => {
    const expiredPaths: string[] = [];

    for (const [key, value] of preparedExports) {
      if (value.expiresAt <= now) {
        preparedExports.delete(key);
        expiredPaths.push(value.outputPath);
      }
    }

    await Promise.all(expiredPaths.map(removeExportFile));
  };

  const deleteAfterReply = (reply: FastifyReply, outputPath: string, stream: ReadStream) => {
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      void removeExportFile(outputPath);
    };

    reply.raw.once('finish', cleanup);
    reply.raw.once('close', cleanup);
    stream.once('close', cleanup);
    stream.once('error', cleanup);
  };

  const rememberPreparedExport = (result: { outputPath: string; fileName: string }): string => {
    const token = randomUUID();
    const now = Date.now();

    void cleanupExpiredPreparedExports(now);

    preparedExports.set(token, {
      outputPath: result.outputPath,
      fileName: result.fileName,
      expiresAt: now + EXPORT_DOWNLOAD_TTL_MS,
    });

    return token;
  };

  const buildPreparedExportResponse = (result: { outputPath: string; fileName: string }) => ({
    token: rememberPreparedExport(result),
    fileName: result.fileName,
    expiresInSeconds: Math.floor(EXPORT_DOWNLOAD_TTL_MS / 1000),
  });

  const sendPreparedExportDownload = async (reply: FastifyReply, token: string) => {
    const prepared = preparedExports.get(token);
    if (!prepared || prepared.expiresAt <= Date.now()) {
      preparedExports.delete(token);
      if (prepared) {
        await removeExportFile(prepared.outputPath);
      }
      reply.code(404);
      throw new Error('导出文件已过期，请重新导出。');
    }

    preparedExports.delete(token);
    const fileStat = await stat(prepared.outputPath);
    const stream = createReadStream(prepared.outputPath);
    deleteAfterReply(reply, prepared.outputPath, stream);
    return reply
      .type(exportContentType(prepared.fileName))
      .header('Content-Disposition', `attachment; filename="${prepared.fileName}"`)
      .header('Content-Length', fileStat.size)
      .header('Cache-Control', 'no-store')
      .send(stream);
  };

  const sendZipFile = async (
    reply: FastifyReply,
    result: { outputPath: string; fileName: string },
  ) => {
    const fileStat = await stat(result.outputPath);
    const stream = createReadStream(result.outputPath);
    deleteAfterReply(reply, result.outputPath, stream);
    return reply
      .type('application/zip')
      .header('Content-Disposition', `attachment; filename="${result.fileName}"`)
      .header('Content-Length', fileStat.size)
      .send(stream);
  };

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

  await auth.register(server);

  server.addHook('onClose', async () => {
    eventLoopDelayMonitor.close();
    await cleanupExpiredPreparedExports(Number.MAX_SAFE_INTEGER);
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
    return sendPreparedExportDownload(reply, params.token);
  });

  server.post('/api/projects/:projectId/export/prepare', async (request) => {
    const params = request.params as { projectId: string };
    const result = await app.exportProject(
      parseProjectId(params.projectId),
      undefined,
      parseProjectExportOptions(request.body),
    );
    return buildPreparedExportResponse(result);
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
    return {
      items: await runQuery.listSiteRuns(parseSiteId(params.siteId)),
    };
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
    return buildPreparedExportResponse(result);
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
    return buildPreparedExportResponse(result);
  });

  server.post('/api/sites/:siteId/pages/export-by-ids/prepare', async (request) => {
    const params = request.params as { siteId: string };
    const body = (request.body ?? {}) as { pageIds?: unknown; artifacts?: unknown };
    const result = await app.exportSitePagesByIds({
      siteId: parseSiteId(params.siteId),
      pageIds: parsePageIdList(body.pageIds),
      artifacts: parseExportArtifacts(body.artifacts),
    });
    return buildPreparedExportResponse(result);
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

  return server;
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? '3100');
  const host = process.env.HOST ?? '127.0.0.1';
  const dbPath = process.env.KVAULT_DB_PATH ?? '.local/state.db';
  const databaseUrl = process.env.KVAULT_DATABASE_URL;
  const adminPassword = process.env.KVAULT_ADMIN_PASSWORD ?? 'kvault-dev';
  const apiKey = process.env.KVAULT_API_KEY;
  const server = await createWebServer({
    dbPath,
    databaseUrl,
    adminPassword,
    apiKey,
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
