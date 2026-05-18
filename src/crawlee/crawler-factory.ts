import { existsSync } from 'node:fs';

import {
  BasicCrawler,
  CheerioCrawler,
  LinkeDOMCrawler,
  PlaywrightCrawler,
  type Configuration,
  type PlaywrightHook,
  type RequestQueue,
} from 'crawlee';

import type { FileArtifactWriter } from '../export/file-artifact-writer.js';
import type {
  ArtifactRunRepository,
  PageRunRepository,
  SitePageRepository,
} from '../db/repositories/index.js';
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
import type { RunLogRepository } from '../db/repositories/index.js';
import type { RunTargetTracker } from './run-target-tracker.js';

/**
 * Shared session pool configuration applied to all HTTP-based crawlers.
 * A pool size of 50 is plenty for any concurrency level used in this project
 * and avoids the default unbounded growth (one session per request).
 */
const SESSION_POOL_OPTIONS = {
  maxPoolSize: 50,
} as const;

/**
 * Lightweight anti-blocking defaults shared by real network crawlers.
 * The delay is per domain and helps avoid bursty Shopify/Cloudflare traffic.
 */
const ANTI_BLOCKING_OPTIONS = {
  retryOnBlocked: true,
  sameDomainDelaySecs: 1,
} as const;

/** True when system Chrome is installed on macOS. */
const HAS_SYSTEM_CHROME =
  process.platform === 'darwin' && existsSync('/Applications/Google Chrome.app');

const SCREENSHOT_NAVIGATION_TIMEOUT_SECS = 45;
const SCREENSHOT_SETTLE_MS = 3000;

const SCREENSHOT_PRE_NAVIGATION_HOOKS: PlaywrightHook[] = [
  async (_context, gotoOptions) => {
    gotoOptions.waitUntil = 'load';
  },
];

const SCREENSHOT_POST_NAVIGATION_HOOKS: PlaywrightHook[] = [
  async ({ page }) => {
    await page.waitForTimeout(SCREENSHOT_SETTLE_MS);
  },
];

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
  targetTracker?: RunTargetTracker;
}

/**
 * Creates the base (Cheerio) crawler responsible for discovering and
 * classifying pages.
 *
 * Concurrency note: CheerioCrawler is HTTP based, so raising maxConcurrency
 * adds parallel request handlers. Repository calls are exposed as async APIs,
 * but the default SQLite client uses node:sqlite DatabaseSync underneath; each
 * DB call therefore runs synchronously on the Node.js event loop and cannot
 * overlap with another SQLite call in the same process.
 */
export function createBaseCrawler(options: CreateBaseCrawlerOptions): CheerioCrawler {
  return new CheerioCrawler(
    {
      requestQueue: options.requestQueue,
      maxConcurrency: 5,
      requestHandlerTimeoutSecs: 30,
      ...ANTI_BLOCKING_OPTIONS,
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
        targetTracker: options.targetTracker,
      }),
      failedRequestHandler: createBaseFailedRequestHandler({
        pageRunRepository: options.pageRunRepository,
        sitePageRepository: options.sitePageRepository,
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
      markdownAdapter: options.markdownAdapter,
      artifactRunRepository: options.artifactRunRepository,
      sitePageRepository: options.sitePageRepository,
      artifactWriter: options.artifactWriter,
      runLog: options.runLog,
    }),
  };

  if (options.markdownAdapter.crawlerType === 'linkedom') {
    return new LinkeDOMCrawler(
      {
        ...sharedOptions,
        ...ANTI_BLOCKING_OPTIONS,
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
        navigationTimeoutSecs: SCREENSHOT_NAVIGATION_TIMEOUT_SECS,
        preNavigationHooks: SCREENSHOT_PRE_NAVIGATION_HOOKS,
        postNavigationHooks: SCREENSHOT_POST_NAVIGATION_HOOKS,
        ...ANTI_BLOCKING_OPTIONS,
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
