import { mkdirSync } from 'node:fs';

import { BasicCrawler, CheerioCrawler, Configuration, RequestQueue } from 'crawlee';

import { FakeClassifier } from '../classification/fake-classifier.js';
import { initializeSchema, openDatabase } from '../db/database.js';
import {
  ArtifactRunRepository,
  PageRunRepository,
  RunRepository,
  SitePageRepository,
  SiteRepository,
} from '../db/repositories.js';
import type { BaseRequestUserData, SpikeRunOptions, SpikeRunSummary } from '../domain/types.js';
import { FakeMarkdownCaptureAdapter } from '../markdown/fake-markdown-adapter.js';
import { RunPlanner } from '../planner/run-planner.js';
import { SystemClock } from '../utils/clock.js';
import { createBaseRequestHandler, createMarkdownRequestHandler } from '../crawlee/handlers.js';

export async function runIntegrationSpike(
  options: SpikeRunOptions,
): Promise<SpikeRunSummary> {
  mkdirSync(options.storageDir, { recursive: true });

  const db = openDatabase(options.dbPath);
  initializeSchema(db);

  const clock = new SystemClock();
  const siteRepository = new SiteRepository(db, clock);
  const runRepository = new RunRepository(db, clock);
  const sitePageRepository = new SitePageRepository(db, clock);
  const pageRunRepository = new PageRunRepository(db, clock);
  const artifactRunRepository = new ArtifactRunRepository(db, clock);

  const planner = new RunPlanner(siteRepository, runRepository, sitePageRepository);
  const plannedRun = planner.plan({
    seedUrl: options.seedUrl,
    siteName: options.siteName,
  });

  const configuration = new Configuration({
    persistStorage: true,
    purgeOnStart: false,
    storageClientOptions: {
      localDataDirectory: options.storageDir,
    },
  });

  const baseQueue = await RequestQueue.open(`run-${plannedRun.runId}-base`, {
    config: configuration,
  });
  const markdownQueue = await RequestQueue.open(`run-${plannedRun.runId}-markdown`, {
    config: configuration,
  });

  await baseQueue.addRequest({
    url: options.seedUrl,
    uniqueKey: `${plannedRun.runId}:${plannedRun.normalizedUrl}:base`,
    userData: {
      stage: 'base',
      runId: plannedRun.runId,
      siteId: plannedRun.siteId,
      sitePageId: plannedRun.sitePageId,
      normalizedUrl: plannedRun.normalizedUrl,
    } satisfies BaseRequestUserData,
  });

  const classifier = new FakeClassifier();
  const markdownAdapter = new FakeMarkdownCaptureAdapter();

  const baseCrawler = new CheerioCrawler({
    requestQueue: baseQueue,
    maxConcurrency: 1,
    requestHandlerTimeoutSecs: 30,
    requestHandler: createBaseRequestHandler({
      classifier,
      markdownQueue,
      pageRunRepository,
      sitePageRepository,
    }),
  }, configuration);

  const markdownCrawler = new BasicCrawler({
    requestQueue: markdownQueue,
    maxConcurrency: 1,
    requestHandlerTimeoutSecs: 30,
    requestHandler: createMarkdownRequestHandler({
      markdownAdapter,
      artifactRunRepository,
    }),
  }, configuration);

  try {
    await baseCrawler.run();
    await markdownCrawler.run();
    runRepository.finishRun(plannedRun.runId, 'succeeded');
  } catch (error) {
    runRepository.finishRun(plannedRun.runId, 'failed');
    throw error;
  } finally {
    db.close();
  }

  const summaryDb = openDatabase(options.dbPath);

  try {
    const summaryPageRuns = new PageRunRepository(summaryDb, clock).countByRun(plannedRun.runId);
    const summaryArtifactRuns = new ArtifactRunRepository(summaryDb, clock).countByRun(
      plannedRun.runId,
    );

    return {
      runId: plannedRun.runId,
      siteId: plannedRun.siteId,
      sitePageId: plannedRun.sitePageId,
      normalizedUrl: plannedRun.normalizedUrl,
      pageRuns: summaryPageRuns,
      artifactRuns: summaryArtifactRuns,
    };
  } finally {
    summaryDb.close();
  }
}
