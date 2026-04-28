import { mkdirSync } from 'node:fs';

import { Configuration } from 'crawlee';

import { FileArtifactWriter } from '../export/file-artifact-writer.js';
import {
  ProjectExporter,
  type ProjectExportResult,
  type SitePageListExportInput,
  type SitePageListExportResult,
} from '../export/project-exporter.js';
import type { Classifier } from '../classification/classifier.js';
import { FakeClassifier } from '../classification/fake-classifier.js';
import { LLMClassifier } from '../classification/llm-classifier.js';
import { extractLabelDefinitionCores } from '../classification/label-definitions.js';
import { createDefaultSiteConfig, loadSiteConfig, parseSiteConfig } from '../config/site-config.js';

import { initializeSchema, openDatabase, type DbClient } from '../db/database.js';
import {
  ArtifactRunRepository,
  PageRunRepository,
  ProjectRepository,
  RunLogRepository,
  RunRepository,
  SitePageRepository,
  SiteRepository,
  type InventoryPageRow,
  type InventorySummary,
  type SampleCaptureRow,
} from '../db/repositories/index.js';
import type {
  BaseRequestUserData,
  RunType,
  RunSummary,
  SiteConfig,
  UpdatePolicy,
} from '../domain/types.js';
import type { MarkdownCaptureAdapter } from '../markdown/markdown-adapter.js';
import { createDefaultMarkdownAdapter } from '../markdown/real-markdown-adapter.js';
import { openRunQueue } from '../crawlee/queue-factory.js';
import { RunTargetTracker } from '../crawlee/run-target-tracker.js';
import {
  createBaseCrawler,
  createMarkdownCrawler,
  createScreenshotCrawler,
} from '../crawlee/crawler-factory.js';
import { RunPlanner } from '../planner/run-planner.js';
import { expandStartupUrlCandidates } from '../planner/startup-url-expander.js';
import type { ScreenshotCaptureAdapter } from '../screenshot/screenshot-adapter.js';
import { PlaywrightScreenshotCaptureAdapter } from '../screenshot/real-screenshot-adapter.js';

import { SystemClock } from '../utils/clock.js';
import { logger, openRuntimeLog, withRuntimeLog } from '../utils/runtime-logger.js';



export interface M1AppOptions {
  dbPath: string;
  databaseUrl?: string;
  classifier?: Classifier;
  markdownAdapter?: MarkdownCaptureAdapter;
  screenshotAdapter?: ScreenshotCaptureAdapter;
}

export class M1App {
  private db!: DbClient;

  private readonly clock;

  private projects!: ProjectRepository;

  private sites!: SiteRepository;

  private runs!: RunRepository;

  private sitePages!: SitePageRepository;

  private pageRuns!: PageRunRepository;

  private artifactRuns!: ArtifactRunRepository;

  private runLogs!: RunLogRepository;

  private planner!: RunPlanner;

  private projectExporter!: ProjectExporter;

  private readonly classifier: Classifier | null;

  private readonly markdownAdapter: MarkdownCaptureAdapter;

  private readonly screenshotAdapter: ScreenshotCaptureAdapter;

  private constructor(private readonly options: M1AppOptions) {
    this.clock = new SystemClock();
    this.classifier = options.classifier ?? null;

    this.markdownAdapter = options.markdownAdapter ?? createDefaultMarkdownAdapter();
    this.screenshotAdapter =
      options.screenshotAdapter ?? new PlaywrightScreenshotCaptureAdapter();
  }

  static async create(options: M1AppOptions): Promise<M1App> {
    const app = new M1App(options);
    app.db = await openDatabase({ path: options.dbPath, url: options.databaseUrl });
    app.projects = new ProjectRepository(app.db, app.clock);
    app.sites = new SiteRepository(app.db, app.clock);
    app.runs = new RunRepository(app.db, app.clock);
    app.sitePages = new SitePageRepository(app.db, app.clock);
    app.pageRuns = new PageRunRepository(app.db, app.clock);
    app.artifactRuns = new ArtifactRunRepository(app.db, app.clock);
    app.runLogs = new RunLogRepository(app.db, app.clock);
    app.planner = new RunPlanner(app.sitePages, app.clock);
    app.projectExporter = new ProjectExporter(app.db, app.clock);
    await initializeSchema(app.db);
    return app;
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  async createProject(name: string): Promise<{ id: number; slug: string }> {
    const project = await this.projects.create(name);
    return {
      id: project.id,
      slug: project.slug,
    };
  }

  async getProjectLabelDefinitions(projectId: number): Promise<unknown> {
    const project = await this.projects.getById(projectId);

    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    return project.labelDefinitions;
  }

  async updateProjectLabelDefinitions(projectId: number, labelDefinitions: unknown): Promise<void> {
    const project = await this.projects.getById(projectId);

    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    await this.projects.updateLabelDefinitions(projectId, labelDefinitions);
  }

  async createSite(input: {
    projectId?: number;
    projectSlug?: string;
    name: string;
    baseUrl: string;
    storageRoot: string;
  }): Promise<{ id: number; name: string }> {
    const project = input.projectId != null
      ? await this.projects.getById(input.projectId)
      : input.projectSlug != null
        ? await this.projects.getBySlug(input.projectSlug)
        : null;

    if (!project) {
      throw new Error(`Project not found`);
    }

    const site = await this.sites.create({
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

  async importSiteConfig(siteId: number, configPath: string): Promise<void> {
    const site = await this.sites.getById(siteId);

    if (!site) {
      throw new Error(`Site ${siteId} not found`);
    }

    await this.sites.updateConfig(siteId, loadSiteConfig(configPath));
  }

  async cloneSiteConfig(sourceSiteId: number, targetSiteId: number): Promise<void> {
    await this.sites.cloneConfig(sourceSiteId, targetSiteId);
  }

  async getSiteConfig(siteId: number): Promise<SiteConfig> {
    const site = await this.sites.getById(siteId);

    if (!site) {
      throw new Error(`Site ${siteId} not found`);
    }

    return site.config;
  }

  async updateSiteConfig(siteId: number, config: SiteConfig): Promise<void> {
    const site = await this.sites.getById(siteId);

    if (!site) {
      throw new Error(`Site ${siteId} not found`);
    }

    await this.sites.updateConfig(siteId, parseSiteConfig(config));
  }

  async runSeed(input: number | {
    siteId: number;
    targetSuccessCount: number | null;
  }): Promise<RunSummary> {
    const normalizedInput =
      typeof input === 'number'
        ? { siteId: input, targetSuccessCount: null }
        : input;

    return this.executeRun({
      siteId: normalizedInput.siteId,
      runType: 'seed_run',
      updatePolicy: 'force_recrawl_all',
      targetSuccessCount: normalizedInput.targetSuccessCount,
      staleAfterMs: null,
    });
  }

  async runCrawl(input: {
    siteId: number;
    updatePolicy: UpdatePolicy;
    targetSuccessCount: number | null;
    staleAfterMs: number | null;
    initialUrls?: string[] | null;
    crawlMaxDepthOverride?: number | null;
  }): Promise<RunSummary> {
    return this.executeRun({
      siteId: input.siteId,
      runType: 'crawl_run',
      updatePolicy: input.updatePolicy,
      targetSuccessCount: input.targetSuccessCount,
      staleAfterMs: input.staleAfterMs,
      initialUrls: input.initialUrls ?? null,
      crawlMaxDepthOverride: input.crawlMaxDepthOverride ?? null,
    });
  }

  async getInventorySummary(siteId: number): Promise<InventorySummary> {
    return this.sitePages.summarizeInventory(siteId);
  }

  async listPendingPages(siteId: number): Promise<InventoryPageRow[]> {
    return this.sitePages.listByInventoryStatus(siteId, 'stage2_pending');
  }

  async listDeniedPages(siteId: number): Promise<InventoryPageRow[]> {
    return this.sitePages.listByInventoryStatus(siteId, 'url_rule_denied');
  }

  async listSampleCaptures(siteId: number, limit: number): Promise<SampleCaptureRow[]> {
    return this.pageRuns.listSampleCaptures(siteId, limit);
  }

  exportProject(projectId: number, outputPath?: string): Promise<ProjectExportResult> {
    return this.projectExporter.exportProject({ projectId, outputPath });
  }

  exportSitePageList(input: SitePageListExportInput): Promise<SitePageListExportResult> {
    return this.projectExporter.exportSitePageList(input);
  }

  private async executeRun(input: {
    siteId: number;
    runType: RunType;
    updatePolicy: UpdatePolicy;
    targetSuccessCount: number | null;
    staleAfterMs: number | null;
    initialUrls?: string[] | null;
    crawlMaxDepthOverride?: number | null;
  }): Promise<RunSummary> {
    const site = await this.sites.getById(input.siteId);

    if (!site) {
      throw new Error(`Site ${input.siteId} not found`);
    }

    mkdirSync(site.storageRoot, { recursive: true });

    const runId = await this.runs.createRun({
      siteId: site.id,
      runType: input.runType,
      updatePolicy: input.updatePolicy,
      targetSuccessCount: input.targetSuccessCount,
      configSnapshot: site.config,
    });

    const runtimeLog = openRuntimeLog({
      storageRoot: site.storageRoot,
      runId,
    });

    await this.runLogs.log({
      crawlRunId: runId,
      level: 'info',
      event: 'runtime_log_ready',
      message: `Runtime log available at ${runtimeLog.relativePath}`,
      meta: {
        relativePath: runtimeLog.relativePath,
      },
    });

    try {
      return await withRuntimeLog(runtimeLog, async () => {
        logger.info('Runtime log initialized', {
          runType: input.runType,
          updatePolicy: input.updatePolicy,
          siteId: site.id,
        });
        return this.executeRunWithRuntime(input, runId);
      });
    } finally {
      runtimeLog.close();
    }
  }

  private async executeRunWithRuntime(input: {
    siteId: number;
    runType: RunType;
    updatePolicy: UpdatePolicy;
    targetSuccessCount: number | null;
    staleAfterMs: number | null;
    initialUrls?: string[] | null;
    crawlMaxDepthOverride?: number | null;
  }, runId: number): Promise<RunSummary> {
    const site = await this.sites.getById(input.siteId);

    if (!site) {
      throw new Error(`Site ${input.siteId} not found`);
    }

    const configuration = new Configuration({
      // Crawlee queues are only transient schedulers for a single run. The durable
      // crawl state lives in SQLite and artifacts, so keeping queues in memory
      // avoids local request_queues lock-file races during long crawls.
      persistStorage: false,
      purgeOnStart: true,
    });

    const artifactWriter = new FileArtifactWriter(site.storageRoot);
    const baseQueue = await openRunQueue(runId, 'base', configuration);
    const markdownQueue = await openRunQueue(runId, 'markdown', configuration);
    const screenshotQueue = await openRunQueue(runId, 'screenshot', configuration);
    const targetTracker = new RunTargetTracker(input.targetSuccessCount);

    const effectiveConfig = input.crawlMaxDepthOverride !== null && input.crawlMaxDepthOverride !== undefined
      ? { ...site.config, runOptions: { ...site.config.runOptions, crawlMaxDepth: input.crawlMaxDepthOverride } }
      : site.config;

    let startupCandidates: Awaited<ReturnType<typeof expandStartupUrlCandidates>>;
    if (input.initialUrls && input.initialUrls.length > 0) {
      startupCandidates = input.initialUrls.map((url) => ({ url, discoverySource: 'inventory' as const }));
    } else {
      const knownUrls =
        input.runType === 'crawl_run'
          ? (await this.sitePages.listKnownUrls(site.id)).map((row) => row.discoveredUrl)
          : [];
      startupCandidates = await expandStartupUrlCandidates({
        seedUrls: site.config.seedUrls,
        sitemapUrls: site.config.sitemaps,
        knownUrls,
      });
    }

    logger.info('Expanded startup URL candidates', {
      runId,
      siteId: site.id,
      candidateCount: startupCandidates.length,
    });

    let firstSitePageId = 0;
    let firstNormalizedUrl = '';
    let plannedEnqueueCount = 0;
    let plannedSkipCount = 0;
    const startupEnqueueLimit = targetTracker.isEnabled()
      ? Math.ceil(input.targetSuccessCount! * 1.5)
      : null;
    const planDecisionCounts = new Map<string, number>();

    for (const candidate of startupCandidates) {
      const planned = await this.planner.planRequest({
        siteId: site.id,
        discoveredUrl: candidate.url,
        discoverySource: candidate.discoverySource,
        discoveryReferrerUrl: null,
        siteConfig: effectiveConfig,
        runType: input.runType,
        updatePolicy: input.updatePolicy,
        staleAfterMs: input.staleAfterMs,
      });

      const skippedByStartupLimit =
        planned.enqueue &&
        startupEnqueueLimit !== null &&
        plannedEnqueueCount >= startupEnqueueLimit;
      const planDecisionKey = planned.enqueue
        ? (skippedByStartupLimit ? 'target_startup_enqueue_limit' : 'enqueue')
        : (planned.planReason ?? 'skip_without_reason');
      planDecisionCounts.set(
        planDecisionKey,
        (planDecisionCounts.get(planDecisionKey) ?? 0) + 1,
      );

      if (planned.enqueue && !skippedByStartupLimit) {
        plannedEnqueueCount += 1;
      } else {
        plannedSkipCount += 1;
      }

      logger.info('Planned startup candidate', {
        runId,
        siteId: site.id,
        discoveredUrl: candidate.url,
        normalizedUrl: planned.normalizedUrl,
        discoverySource: candidate.discoverySource,
        sitePageId: planned.sitePageId,
        enqueue: planned.enqueue,
        urlRuleDecision: planned.urlRuleDecision,
        planReason: planned.planReason,
        startupEnqueueLimit,
        skippedByStartupLimit,
      });

      if (firstSitePageId === 0) {
        firstSitePageId = planned.sitePageId;
        firstNormalizedUrl = planned.normalizedUrl;
      }

      if (!planned.enqueue || skippedByStartupLimit) {
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

    logger.info('Planned startup candidate summary', {
      runId,
      siteId: site.id,
      candidateCount: startupCandidates.length,
      enqueueCount: plannedEnqueueCount,
      skipCount: plannedSkipCount,
      decisionCounts: Object.fromEntries(planDecisionCounts),
    });

    const labelDefinitions = (await this.projects.getById(site.projectId))?.labelDefinitions ?? [];
    const classifier = this.classifier
      ?? (extractLabelDefinitionCores(labelDefinitions).length > 0
        ? new LLMClassifier(labelDefinitions)
        : new FakeClassifier());

    const baseCrawler = createBaseCrawler({
      requestQueue: baseQueue,
      configuration,
      classifier,
      siteConfig: effectiveConfig,
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
      runLog: this.runLogs,
      targetTracker,
    });

    const markdownCrawler = createMarkdownCrawler({
      requestQueue: markdownQueue,
      configuration,
      markdownAdapter: this.markdownAdapter,
      artifactRunRepository: this.artifactRuns,
      sitePageRepository: this.sitePages,
      artifactWriter,
      runLog: this.runLogs,
    });

    const screenshotCrawler = createScreenshotCrawler({
      requestQueue: screenshotQueue,
      configuration,
      screenshotAdapter: this.screenshotAdapter,
      artifactRunRepository: this.artifactRuns,
      sitePageRepository: this.sitePages,
      artifactWriter,
      runLog: this.runLogs,
    });

    await this.runLogs.log({
      crawlRunId: runId,
      level: 'info',
      event: 'crawl_started',
      message: `Run ${runId} started (${input.runType}, updatePolicy=${input.updatePolicy})`,
      meta: {
        runType: input.runType,
        updatePolicy: input.updatePolicy,
        targetSuccessCount: input.targetSuccessCount,
        siteId: site.id,
      },
    });

    try {
      await baseCrawler.run();

      if (input.runType === 'crawl_run') {
        await markdownCrawler.run();
        await screenshotCrawler.run();
      }

      await this.runs.refreshCounts(runId);
      await this.runs.finishRun(runId, 'succeeded');
      await this.runLogs.log({
        crawlRunId: runId,
        level: 'info',
        event: 'crawl_finished',
        message: `Run ${runId} finished successfully`,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.runs.refreshCounts(runId);
      await this.runs.finishRun(runId, 'failed', errorMessage);
      await this.runLogs.log({
        crawlRunId: runId,
        level: 'error',
        event: 'crawl_error',
        message: `Run ${runId} failed: ${errorMessage}`,
        meta: { stack: error instanceof Error ? (error.stack ?? null) : null },
      });
      throw error;
    }

    return {
      runId,
      siteId: site.id,
      sitePageId: firstSitePageId,
      normalizedUrl: firstNormalizedUrl,
      pageRuns: await this.pageRuns.countByRun(runId),
      artifactRuns: await this.artifactRuns.countByRun(runId),
    };
  }
}
