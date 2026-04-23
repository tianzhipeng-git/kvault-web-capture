import { mkdirSync } from 'node:fs';

import { BasicCrawler, CheerioCrawler, Configuration } from 'crawlee';

import { FileArtifactWriter } from '../export/file-artifact-writer.js';
import type { Classifier } from '../classification/classifier.js';
import { FakeClassifier } from '../classification/fake-classifier.js';
import { createDefaultSiteConfig, loadSiteConfig } from '../config/site-config.js';
import {
  createBaseRequestHandler,
  createMarkdownFailedRequestHandler,
  createMarkdownRequestHandler,
  createScreenshotFailedRequestHandler,
  createScreenshotRequestHandler,
} from '../crawlee/handlers.js';
import { initializeSchema, openDatabase } from '../db/database.js';
import {
  ArtifactRunRepository,
  PageRunRepository,
  ProjectRepository,
  RunRepository,
  SitePageRepository,
  SiteRepository,
  type InventoryPageRow,
  type InventorySummary,
  type SampleCaptureRow,
} from '../db/repositories.js';
import type {
  BaseRequestUserData,
  RunType,
  SpikeRunSummary,
  UpdatePolicy,
} from '../domain/types.js';
import { FakeMarkdownCaptureAdapter, type MarkdownCaptureAdapter } from '../markdown/fake-markdown-adapter.js';
import { openRunQueue } from '../crawlee/queue-factory.js';
import { RunPlanner } from '../planner/run-planner.js';
import { expandStartupUrlCandidates } from '../planner/startup-url-expander.js';
import {
  FakeScreenshotCaptureAdapter,
  type ScreenshotCaptureAdapter,
} from '../screenshot/fake-screenshot-adapter.js';
import { SystemClock } from '../utils/clock.js';

export interface M1AppOptions {
  dbPath: string;
  classifier?: Classifier;
  markdownAdapter?: MarkdownCaptureAdapter;
  screenshotAdapter?: ScreenshotCaptureAdapter;
}

export class M1App {
  private readonly db;

  private readonly clock;

  private readonly projects;

  private readonly sites;

  private readonly runs;

  private readonly sitePages;

  private readonly pageRuns;

  private readonly artifactRuns;

  private readonly planner;

  private readonly classifier: Classifier;

  private readonly markdownAdapter: MarkdownCaptureAdapter;

  private readonly screenshotAdapter: ScreenshotCaptureAdapter;

  constructor(private readonly options: M1AppOptions) {
    this.db = openDatabase(this.options.dbPath);
    this.clock = new SystemClock();
    this.projects = new ProjectRepository(this.db, this.clock);
    this.sites = new SiteRepository(this.db, this.clock);
    this.runs = new RunRepository(this.db, this.clock);
    this.sitePages = new SitePageRepository(this.db, this.clock);
    this.pageRuns = new PageRunRepository(this.db, this.clock);
    this.artifactRuns = new ArtifactRunRepository(this.db, this.clock);
    this.planner = new RunPlanner(this.sitePages, this.clock);
    initializeSchema(this.db);
    this.classifier = options.classifier ?? new FakeClassifier();
    this.markdownAdapter = options.markdownAdapter ?? new FakeMarkdownCaptureAdapter();
    this.screenshotAdapter = options.screenshotAdapter ?? new FakeScreenshotCaptureAdapter();
  }

  close(): void {
    this.db.close();
  }

  createProject(name: string): { id: number; slug: string } {
    const project = this.projects.create(name);
    return {
      id: project.id,
      slug: project.slug,
    };
  }

  createSite(input: {
    projectSlug: string;
    name: string;
    baseUrl: string;
    storageRoot: string;
  }): { id: number; name: string } {
    const project = this.projects.getBySlug(input.projectSlug);

    if (!project) {
      throw new Error(`Project ${input.projectSlug} not found`);
    }

    const site = this.sites.create({
      projectId: project.id,
      name: input.name,
      baseUrl: input.baseUrl,
      storageRoot: input.storageRoot,
      config: createDefaultSiteConfig(input.baseUrl),
    });

    return {
      id: site.id,
      name: site.name,
    };
  }

  importSiteConfig(siteId: number, configPath: string): void {
    const site = this.sites.getById(siteId);

    if (!site) {
      throw new Error(`Site ${siteId} not found`);
    }

    this.sites.updateConfig(siteId, loadSiteConfig(configPath));
  }

  cloneSiteConfig(sourceSiteId: number, targetSiteId: number): void {
    this.sites.cloneConfig(sourceSiteId, targetSiteId);
  }

  async runSeed(siteId: number): Promise<SpikeRunSummary> {
    return this.executeRun({
      siteId,
      runType: 'seed_run',
      updatePolicy: 'force_recrawl_all',
      targetSuccessCount: null,
      staleAfterMs: null,
    });
  }

  async runCrawl(input: {
    siteId: number;
    updatePolicy: UpdatePolicy;
    targetSuccessCount: number | null;
    staleAfterMs: number | null;
  }): Promise<SpikeRunSummary> {
    return this.executeRun({
      siteId: input.siteId,
      runType: 'crawl_run',
      updatePolicy: input.updatePolicy,
      targetSuccessCount: input.targetSuccessCount,
      staleAfterMs: input.staleAfterMs,
    });
  }

  getInventorySummary(siteId: number): InventorySummary {
    return this.sitePages.summarizeInventory(siteId);
  }

  listPendingPages(siteId: number): InventoryPageRow[] {
    return this.sitePages.listByInventoryStatus(siteId, 'stage2_pending');
  }

  listDeniedPages(siteId: number): InventoryPageRow[] {
    return this.sitePages.listByInventoryStatus(siteId, 'url_rule_denied');
  }

  listSampleCaptures(siteId: number, limit: number): SampleCaptureRow[] {
    return this.pageRuns.listSampleCaptures(siteId, limit);
  }

  private async executeRun(input: {
    siteId: number;
    runType: RunType;
    updatePolicy: UpdatePolicy;
    targetSuccessCount: number | null;
    staleAfterMs: number | null;
  }): Promise<SpikeRunSummary> {
    const site = this.sites.getById(input.siteId);

    if (!site) {
      throw new Error(`Site ${input.siteId} not found`);
    }

    mkdirSync(site.storageRoot, { recursive: true });

    const runId = this.runs.createRun({
      siteId: site.id,
      runType: input.runType,
      updatePolicy: input.updatePolicy,
      targetSuccessCount: input.targetSuccessCount,
      configSnapshot: site.config,
    });

    const configuration = new Configuration({
      persistStorage: true,
      purgeOnStart: false,
      storageClientOptions: {
        localDataDirectory: site.storageRoot,
      },
    });

    const artifactWriter = new FileArtifactWriter(site.storageRoot);
    const baseQueue = await openRunQueue(runId, 'base', configuration);
    const markdownQueue = await openRunQueue(runId, 'markdown', configuration);
    const screenshotQueue = await openRunQueue(runId, 'screenshot', configuration);
    const startupCandidates = await expandStartupUrlCandidates({
      seedUrls: site.config.seedUrls,
      sitemapUrls: site.config.sitemaps,
      knownUrls:
        input.runType === 'crawl_run'
          ? this.sitePages.listKnownUrls(site.id).map((row) => row.discoveredUrl)
          : [],
    });

    let firstSitePageId = 0;
    let firstNormalizedUrl = '';

    for (const candidate of startupCandidates) {
      const planned = this.planner.planRequest({
        siteId: site.id,
        discoveredUrl: candidate.url,
        discoverySource: candidate.discoverySource,
        discoveryReferrerUrl: null,
        siteConfig: site.config,
        runType: input.runType,
        updatePolicy: input.updatePolicy,
        staleAfterMs: input.staleAfterMs,
      });

      if (firstSitePageId === 0) {
        firstSitePageId = planned.sitePageId;
        firstNormalizedUrl = planned.normalizedUrl;
      }

      if (!planned.enqueue) {
        continue;
      }

      await baseQueue.addRequest({
        url: candidate.url,
        uniqueKey: `base:${runId}:${planned.sitePageId}`,
        userData: {
          stage: 'base',
          runId,
          siteId: site.id,
          sitePageId: planned.sitePageId,
          normalizedUrl: planned.normalizedUrl,
          depth: 0,
          runType: input.runType,
        } satisfies BaseRequestUserData,
      });
    }

    const baseCrawler = new CheerioCrawler(
      {
        requestQueue: baseQueue,
        maxConcurrency: 1,
        requestHandlerTimeoutSecs: 30,
        requestHandler: createBaseRequestHandler({
          classifier: this.classifier,
          siteConfig: site.config,
          runType: input.runType,
          updatePolicy: input.updatePolicy,
          staleAfterMs: input.staleAfterMs,
          baseQueue,
          markdownQueue,
          screenshotQueue,
          artifactWriter,
          pageRunRepository: this.pageRuns,
          sitePageRepository: this.sitePages,
          runPlanner: this.planner,
        }),
      },
      configuration,
    );

    const markdownCrawler = new BasicCrawler(
      {
        requestQueue: markdownQueue,
        maxConcurrency: 1,
        requestHandlerTimeoutSecs: 30,
        requestHandler: createMarkdownRequestHandler({
          markdownAdapter: this.markdownAdapter,
          artifactRunRepository: this.artifactRuns,
          sitePageRepository: this.sitePages,
          artifactWriter,
        }),
        failedRequestHandler: createMarkdownFailedRequestHandler({
          artifactRunRepository: this.artifactRuns,
          sitePageRepository: this.sitePages,
        }),
      },
      configuration,
    );

    const screenshotCrawler = new BasicCrawler(
      {
        requestQueue: screenshotQueue,
        maxConcurrency: 1,
        requestHandlerTimeoutSecs: 30,
        requestHandler: createScreenshotRequestHandler({
          screenshotAdapter: this.screenshotAdapter,
          artifactRunRepository: this.artifactRuns,
          sitePageRepository: this.sitePages,
          artifactWriter,
        }),
        failedRequestHandler: createScreenshotFailedRequestHandler({
          artifactRunRepository: this.artifactRuns,
          sitePageRepository: this.sitePages,
        }),
      },
      configuration,
    );

    try {
      await baseCrawler.run();

      if (input.runType === 'crawl_run') {
        await markdownCrawler.run();
        await screenshotCrawler.run();
      }

      this.runs.refreshCounts(runId);
      this.runs.finishRun(runId, 'succeeded');
    } catch (error) {
      this.runs.refreshCounts(runId);
      this.runs.finishRun(runId, 'failed');
      throw error;
    }

    return {
      runId,
      siteId: site.id,
      sitePageId: firstSitePageId,
      normalizedUrl: firstNormalizedUrl,
      pageRuns: this.pageRuns.countByRun(runId),
      artifactRuns: this.artifactRuns.countByRun(runId),
    };
  }
}
