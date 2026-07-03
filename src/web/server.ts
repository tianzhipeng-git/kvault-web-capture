import 'dotenv/config';
import { fileURLToPath } from 'node:url';

import Fastify, { type FastifyInstance } from 'fastify';

import { CaptureApp } from '../app/capture-app.js';
import { openDatabase } from '../db/database.js';
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
import { ExportDownloadStore } from './http/export-downloads.js';
import {
  DEFAULT_EVENT_LOOP_DELAY_INTERVAL_MS,
  DEFAULT_EVENT_LOOP_DELAY_THRESHOLD_MS,
  parsePositiveNumber,
  startEventLoopDelayMonitor,
} from './http/event-loop-delay-monitor.js';
import { registerWebRoutes } from './routes/register-web-routes.js';
import { RunCoordinator } from './services/run-coordinator.js';

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
  const exportDownloads = new ExportDownloadStore();

  await auth.register(server);

  server.addHook('onClose', async () => {
    eventLoopDelayMonitor.close();
    await exportDownloads.cleanupExpiredPreparedExports(Number.MAX_SAFE_INTEGER);
    await app.close();
    await queryDb.close();
  });

  server.setErrorHandler((error, _request, reply) => {
    const statusCode = reply.statusCode >= 400 ? reply.statusCode : 400;
    reply.code(statusCode).send({
      message: error instanceof Error ? error.message : '请求失败。',
    });
  });

  registerWebRoutes({
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
