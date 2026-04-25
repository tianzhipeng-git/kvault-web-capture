import { existsSync } from 'node:fs';

import {
  BasicCrawler,
  CheerioCrawler,
  LinkeDOMCrawler,
  PlaywrightCrawler,
  type Configuration,
  type RequestQueue,
} from 'crawlee';

import type { FileArtifactWriter } from '../export/file-artifact-writer.js';
import type {
  ArtifactRunRepository,
  PageRunRepository,
  SitePageRepository,
} from '../db/repositories.js';
import type { Classifier } from '../classification/classifier.js';
import type { RunType, SiteConfig, UpdatePolicy } from '../domain/types.js';
import type { MarkdownCaptureAdapter } from '../markdown/markdown-adapter.js';
import type { ScreenshotCaptureAdapter } from '../screenshot/screenshot-adapter.js';
import { RunPlanner } from '../planner/run-planner.js';
import {
  createBaseFailedRequestHandler,
  createBaseRequestHandler,
  createMarkdownFailedRequestHandler,
  createMarkdownRequestHandler,
  createScreenshotFailedRequestHandler,
  createScreenshotRequestHandler,
} from './handlers.js';
import type { RunLogRepository } from '../db/repositories.js';

/**
 * Shared session pool configuration applied to all HTTP-based crawlers.
 * A pool size of 50 is plenty for any concurrency level used in this project
 * and avoids the default unbounded growth (one session per request).
 */
const SESSION_POOL_OPTIONS = {
  maxPoolSize: 50,
} as const;

/** True when system Chrome is installed on macOS. */
const HAS_SYSTEM_CHROME =
  process.platform === 'darwin' && existsSync('/Applications/Google Chrome.app');

// ---------------------------------------------------------------------------
// Base crawler
// ---------------------------------------------------------------------------

export interface CreateBaseCrawlerOptions {
  requestQueue: RequestQueue;
  configuration: Configuration;
  classifier: Classifier;
  siteConfig: SiteConfig;
  runType: RunType;
  updatePolicy: UpdatePolicy;
  staleAfterMs: number | null;
  baseQueue: RequestQueue;
  markdownQueue: RequestQueue;
  screenshotQueue: RequestQueue;
  artifactWriter: FileArtifactWriter;
  pageRunRepository: PageRunRepository;
  sitePageRepository: SitePageRepository;
  runPlanner: RunPlanner;
  runLog: RunLogRepository;
}

/**
 * Creates the base (Cheerio) crawler responsible for discovering and
 * classifying pages.
 *
 * Concurrency note: CheerioCrawler is pure HTTP — raising maxConcurrency
 * only adds parallel HTTP connections.  All repository calls use
 * better-sqlite3 (synchronous), so they serialize naturally on the Node.js
 * event loop and are safe under async concurrency.
 */
export function createBaseCrawler(options: CreateBaseCrawlerOptions): CheerioCrawler {
  return new CheerioCrawler(
    {
      requestQueue: options.requestQueue,
      maxConcurrency: 5,
      requestHandlerTimeoutSecs: 30,
      sessionPoolOptions: SESSION_POOL_OPTIONS,
      requestHandler: createBaseRequestHandler({
        classifier: options.classifier,
        siteConfig: options.siteConfig,
        runType: options.runType,
        updatePolicy: options.updatePolicy,
        staleAfterMs: options.staleAfterMs,
        baseQueue: options.baseQueue,
        markdownQueue: options.markdownQueue,
        screenshotQueue: options.screenshotQueue,
        artifactWriter: options.artifactWriter,
        pageRunRepository: options.pageRunRepository,
        sitePageRepository: options.sitePageRepository,
        runPlanner: options.runPlanner,
        runLog: options.runLog,
      }),
      failedRequestHandler: createBaseFailedRequestHandler({
        pageRunRepository: options.pageRunRepository,
        runLog: options.runLog,
      }),
    },
    options.configuration,
  );
}

// ---------------------------------------------------------------------------
// Markdown crawler
// ---------------------------------------------------------------------------

export interface CreateMarkdownCrawlerOptions {
  requestQueue: RequestQueue;
  configuration: Configuration;
  markdownAdapter: MarkdownCaptureAdapter;
  artifactRunRepository: ArtifactRunRepository;
  sitePageRepository: SitePageRepository;
  artifactWriter: FileArtifactWriter;
  runLog: RunLogRepository;
}

export function createMarkdownCrawler(
  options: CreateMarkdownCrawlerOptions,
): LinkeDOMCrawler | BasicCrawler {
  const handlerDeps = {
    markdownAdapter: options.markdownAdapter,
    artifactRunRepository: options.artifactRunRepository,
    sitePageRepository: options.sitePageRepository,
    artifactWriter: options.artifactWriter,
    runLog: options.runLog,
  };

  const sharedOptions = {
    requestQueue: options.requestQueue,
    maxConcurrency: 3,
    requestHandlerTimeoutSecs: 30,
    requestHandler: createMarkdownRequestHandler(handlerDeps),
    failedRequestHandler: createMarkdownFailedRequestHandler({
      artifactRunRepository: options.artifactRunRepository,
      sitePageRepository: options.sitePageRepository,
      runLog: options.runLog,
    }),
  };

  if (options.markdownAdapter.crawlerType === 'linkedom') {
    return new LinkeDOMCrawler(
      {
        ...sharedOptions,
        sessionPoolOptions: SESSION_POOL_OPTIONS,
      },
      options.configuration,
    );
  }

  // BasicCrawler has no session pool concept.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new BasicCrawler(sharedOptions, options.configuration) as any;
}

// ---------------------------------------------------------------------------
// Screenshot crawler
// ---------------------------------------------------------------------------

export interface CreateScreenshotCrawlerOptions {
  requestQueue: RequestQueue;
  configuration: Configuration;
  screenshotAdapter: ScreenshotCaptureAdapter;
  artifactRunRepository: ArtifactRunRepository;
  sitePageRepository: SitePageRepository;
  artifactWriter: FileArtifactWriter;
  runLog: RunLogRepository;
}

/**
 * Creates the screenshot (Playwright) crawler.
 *
 * Concurrency note: each concurrent Playwright task launches a separate
 * browser page (~100-200 MB RAM each).  maxConcurrency=3 means up to 3
 * browser pages running in parallel — monitor memory if the target site is
 * heavy.
 */
export function createScreenshotCrawler(
  options: CreateScreenshotCrawlerOptions,
): PlaywrightCrawler | BasicCrawler {
  const handlerDeps = {
    screenshotAdapter: options.screenshotAdapter,
    artifactRunRepository: options.artifactRunRepository,
    sitePageRepository: options.sitePageRepository,
    artifactWriter: options.artifactWriter,
    runLog: options.runLog,
  };

  const sharedOptions = {
    requestQueue: options.requestQueue,
    requestHandlerTimeoutSecs: 30,
    requestHandler: createScreenshotRequestHandler(handlerDeps),
    failedRequestHandler: createScreenshotFailedRequestHandler({
      artifactRunRepository: options.artifactRunRepository,
      sitePageRepository: options.sitePageRepository,
      runLog: options.runLog,
    }),
  };

  if (options.screenshotAdapter.crawlerType === 'playwright') {
    return new PlaywrightCrawler(
      {
        ...sharedOptions,
        maxConcurrency: 3,
        sessionPoolOptions: SESSION_POOL_OPTIONS,
        ...(HAS_SYSTEM_CHROME
          ? { launchContext: { launchOptions: { channel: 'chrome' as const } } }
          : {}),
      },
      options.configuration,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new BasicCrawler(
    { ...sharedOptions, maxConcurrency: 1 },
    options.configuration,
  ) as any;
}
