import 'dotenv/config';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify, { type FastifyInstance } from 'fastify';

import { M1App } from '../app/services.js';
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
import { mapConfigFormToSiteConfig, mapRunForm } from './services/config-mapper.js';
import { RunCoordinator } from './services/run-coordinator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const frontendDir = join(__dirname, 'frontend/dist');

function parseSiteId(value: string): number {
  const siteId = Number(value);

  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error('siteId 无效。');
  }

  return siteId;
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

function readFrontendAsset(name: string): string {
  return readFileSync(join(frontendDir, name), 'utf8');
}

export interface WebServerOptions {
  dbPath: string;
  adminPassword: string;
  port?: number;
  host?: string;
  maxConcurrentRuns?: number;
  sessionTtlMs?: number;
}

export async function createWebServer(options: WebServerOptions): Promise<FastifyInstance> {
  const server = Fastify({
    logger: false,
  });
  const app = new M1App({ dbPath: options.dbPath });
  const queryDb = openDatabase(options.dbPath);
  const auth = new SessionAuth(options.adminPassword, options.sessionTtlMs ?? 1000 * 60 * 60 * 8);
  const coordinator = new RunCoordinator(options.maxConcurrentRuns ?? 2);
  const projectQuery = new ProjectListQuery(queryDb);
  const siteOverviewQuery = new SiteOverviewQuery(queryDb);
  const sitePageQuery = new SitePageListQuery(queryDb);
  const sitePageDetailQuery = new SitePageDetailQuery(queryDb);
  const runQuery = new RunSummaryQuery(queryDb);
  const runLogQuery = new RunLogQuery(queryDb);
  const pendingReviewQuery = new PendingReviewQuery(queryDb);

  await auth.register(server);

  server.addHook('onClose', async () => {
    app.close();
    queryDb.close();
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
  }));

  server.setNotFoundHandler((request, reply) => {
    if (request.method === 'GET' && !request.url.startsWith('/api/')) {
      reply.type('text/html; charset=utf-8').send(readFrontendAsset('index.html'));
      return;
    }
    reply.code(404).send({ message: 'Not found' });
  });

  server.get('/', async (_request, reply) => {
    reply.type('text/html; charset=utf-8').send(readFrontendAsset('index.html'));
  });

  server.get('/app.js', async (_request, reply) => {
    reply.type('application/javascript; charset=utf-8').send(readFrontendAsset('app.js'));
  });

  server.get('/styles.css', async (_request, reply) => {
    reply.type('text/css; charset=utf-8').send(readFrontendAsset('styles.css'));
  });

  server.get('/assets/:file', async (request, reply) => {
    const params = request.params as { file: string };
    try {
      reply.send(readFileSync(join(frontendDir, 'assets', params.file)));
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
    items: projectQuery.listProjects(),
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
      items: projectQuery.listSites(parseProjectId(params.projectId)),
    };
  });

  server.get('/api/projects/:projectId/tag-definitions', async (request) => {
    const params = request.params as { projectId: string };
    return {
      tagDefinitions: app.getProjectTagDefinitions(parseProjectId(params.projectId)),
    };
  });

  server.put('/api/projects/:projectId/tag-definitions', async (request) => {
    const params = request.params as { projectId: string };
    const body = (request.body ?? {}) as { tagDefinitions?: unknown };
    const tagDefinitions = body.tagDefinitions ?? [];
    app.updateProjectTagDefinitions(parseProjectId(params.projectId), tagDefinitions);
    return {
      status: 'ok',
      tagDefinitions,
    };
  });

  server.post('/api/projects/:projectId/export', async (request, reply) => {
    const params = request.params as { projectId: string };
    const result = await app.exportProject(parseProjectId(params.projectId));
    return reply
      .type('application/zip')
      .header('Content-Disposition', `attachment; filename="${result.fileName}"`)
      .header('Content-Length', statSync(result.outputPath).size)
      .send(createReadStream(result.outputPath));
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
    app.updateSiteConfig(parseSiteId(params.siteId), config);
    return {
      status: 'ok',
      config,
    };
  });

  server.post('/api/sites/:siteId/config/import', async (request) => {
    const params = request.params as { siteId: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const config = mapConfigFormToSiteConfig(body.config as Record<string, unknown>);
    app.updateSiteConfig(parseSiteId(params.siteId), config);
    return {
      status: 'ok',
      config,
    };
  });

  server.post('/api/sites/:siteId/config/clone-from/:sourceSiteId', async (request) => {
    const params = request.params as { siteId: string; sourceSiteId: string };
    app.cloneSiteConfig(parseSiteId(params.sourceSiteId), parseSiteId(params.siteId));
    return {
      status: 'ok',
      config: app.getSiteConfig(parseSiteId(params.siteId)),
    };
  });

  server.post('/api/sites/:siteId/runs/seed', async (request, reply) => {
    const params = request.params as { siteId: string };
    const siteId = parseSiteId(params.siteId);
    void coordinator.startSeed(app, siteId).catch(() => { });
    const latestRun = runQuery.getLatestRunForSite(siteId, 'seed_run');

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
    const latestRun = runQuery.getLatestRunForSite(siteId, 'crawl_run');

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
      items: runQuery.listSiteRuns(parseSiteId(params.siteId)),
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
      items: runLogQuery.listRunLogs(runId, sitePageId),
      errorMessage: runLogQuery.getRunErrorMessage(runId),
    };
  });

  server.get('/api/sites/:siteId/overview', async (request) => {
    const params = request.params as { siteId: string };
    return siteOverviewQuery.getSiteOverview(parseSiteId(params.siteId));
  });

  server.get('/api/sites/:siteId/pages', async (request) => {
    const params = request.params as { siteId: string };
    const query = request.query as Record<string, string | undefined>;
    const crawlRunId = query.crawlRunId === undefined ? undefined : Number(query.crawlRunId);

    if (crawlRunId !== undefined && (!Number.isInteger(crawlRunId) || crawlRunId <= 0)) {
      throw new Error('crawlRunId 无效。');
    }

    return sitePageQuery.listPages({
      siteId: parseSiteId(params.siteId),
      page: Number(query.page ?? '1'),
      pageSize: Number(query.pageSize ?? '20'),
      status: query.status,
      query: query.query,
      tag: query.tag,
      pendingReason: query.pendingReason,
      discoverySource: query.discoverySource,
      crawlRunId,
    });
  });

  server.get('/api/sites/:siteId/pages/:sitePageId', async (request) => {
    const params = request.params as { siteId: string; sitePageId: string };
    return sitePageDetailQuery.getPageDetail(
      parseSiteId(params.siteId),
      parseRunId(params.sitePageId),
    );
  });

  server.get('/api/sites/:siteId/artifacts/:artifactRunId/file', async (request, reply) => {
    const params = request.params as { siteId: string; artifactRunId: string };
    const artifact = sitePageDetailQuery.getArtifactFile(
      parseSiteId(params.siteId),
      parseArtifactRunId(params.artifactRunId),
    );
    reply
      .type(artifactContentType(artifact.outputPath, artifact.artifactType))
      .send(readFileSync(artifact.outputPath));
  });

  server.get('/api/sites/:siteId/pending-review', async (request) => {
    const params = request.params as { siteId: string };
    return {
      items: pendingReviewQuery.getPendingReview(parseSiteId(params.siteId)),
    };
  });

  server.get('/api/sites/:siteId/sample-captures', async (request) => {
    const params = request.params as { siteId: string };
    const query = request.query as Record<string, string | undefined>;
    return {
      items: app.listSampleCaptures(
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
  const adminPassword = process.env.KVAULT_ADMIN_PASSWORD ?? 'kvault-dev';
  const server = await createWebServer({
    dbPath,
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
