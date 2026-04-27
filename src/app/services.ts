import { mkdirSync } from 'node:fs';

import { Configuration } from 'crawlee';

import { FileArtifactWriter } from '../export/file-artifact-writer.js';
import { ProjectExporter, type ProjectExportResult } from '../export/project-exporter.js';
import type { Classifier } from '../classification/classifier.js';
import { FakeClassifier } from '../classification/fake-classifier.js';
import { LLMClassifier } from '../classification/llm-classifier.js';
import { extractLabelDefinitionCores } from '../classification/label-definitions.js';
import { createDefaultSiteConfig, loadSiteConfig, parseSiteConfig } from '../config/site-config.js';

import { initializeSchema, openDatabase } from '../db/database.js';
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
  SiteConfig,
  SpikeRunSummary,
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

  private readonly runLogs;

  private readonly planner;

  private readonly projectExporter;

  private readonly classifier: Classifier | null;

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
    this.runLogs = new RunLogRepository(this.db, this.clock);
    this.planner = new RunPlanner(this.sitePages, this.clock);
    this.projectExporter = new ProjectExporter(this.db, this.clock);
    initializeSchema(this.db);
    this.classifier = options.classifier ?? null;

    this.markdownAdapter = options.markdownAdapter ?? createDefaultMarkdownAdapter();
    this.screenshotAdapter =
      options.screenshotAdapter ?? new PlaywrightScreenshotCaptureAdapter();
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

  getProjectLabelDefinitions(projectId: number): unknown {
    const project = this.projects.getById(projectId);

    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    return project.labelDefinitions;
  }

  updateProjectLabelDefinitions(projectId: number, labelDefinitions: unknown): void {
    const project = this.projects.getById(projectId);

    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    this.projects.updateLabelDefinitions(projectId, labelDefinitions);
  }

  createSite(input: {
    projectId?: number;
    projectSlug?: string;
    name: string;
    baseUrl: string;
    storageRoot: string;
  }): { id: number; name: string } {
    const project = input.projectId != null
      ? this.projects.getById(input.projectId)
      : input.projectSlug != null
        ? this.projects.getBySlug(input.projectSlug)
        : null;

    if (!project) {
      throw new Error(`Project not found`);
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

  getSiteConfig(siteId: number): SiteConfig {
    const site = this.sites.getById(siteId);

    if (!site) {
      throw new Error(`Site ${siteId} not found`);
    }

    return site.config;
  }

  updateSiteConfig(siteId: number, config: SiteConfig): void {
    const site = this.sites.getById(siteId);

    if (!site) {
      throw new Error(`Site ${siteId} not found`);
    }

    this.sites.updateConfig(siteId, parseSiteConfig(config));
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
    initialUrls?: string[] | null;
    crawlMaxDepthOverride?: number | null;
  }): Promise<SpikeRunSummary> {
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

  exportProject(projectId: number, outputPath?: string): Promise<ProjectExportResult> {
    return this.projectExporter.exportProject({ projectId, outputPath });
  }

  private async executeRun(input: {
    siteId: number;
    runType: RunType;
    updatePolicy: UpdatePolicy;
    targetSuccessCount: number | null;
    staleAfterMs: number | null;
    initialUrls?: string[] | null;
    crawlMaxDepthOverride?: number | null;
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

    const runtimeLog = openRuntimeLog({
      storageRoot: site.storageRoot,
      runId,
    });

    this.runLogs.log({
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
  }, runId: number): Promise<SpikeRunSummary> {
    const site = this.sites.getById(input.siteId);

    if (!site) {
      throw new Error(`Site ${input.siteId} not found`);
    }

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
    const targetTracker =
      input.runType === 'crawl_run' ? new RunTargetTracker(input.targetSuccessCount) : undefined;

    const effectiveConfig = input.crawlMaxDepthOverride !== null && input.crawlMaxDepthOverride !== undefined
      ? { ...site.config, runOptions: { ...site.config.runOptions, crawlMaxDepth: input.crawlMaxDepthOverride } }
      : site.config;

    let startupCandidates: Awaited<ReturnType<typeof expandStartupUrlCandidates>>;
    if (input.initialUrls && input.initialUrls.length > 0) {
      startupCandidates = input.initialUrls.map((url) => ({ url, discoverySource: 'inventory' as const }));
    } else {
      const knownUrls =
        input.runType === 'crawl_run'
          ? this.sitePages.listKnownUrls(site.id).map((row) => row.discoveredUrl)
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
    const planDecisionCounts = new Map<string, number>();

    for (const candidate of startupCandidates) {
      const planned = this.planner.planRequest({
        siteId: site.id,
        discoveredUrl: candidate.url,
        discoverySource: candidate.discoverySource,
        discoveryReferrerUrl: null,
        siteConfig: effectiveConfig,
        runType: input.runType,
        updatePolicy: input.updatePolicy,
        staleAfterMs: input.staleAfterMs,
      });

      const planDecisionKey = planned.enqueue
        ? 'enqueue'
        : (planned.planReason ?? 'skip_without_reason');
      planDecisionCounts.set(
        planDecisionKey,
        (planDecisionCounts.get(planDecisionKey) ?? 0) + 1,
      );

      if (planned.enqueue) {
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

    logger.info('Planned startup candidate summary', {
      runId,
      siteId: site.id,
      candidateCount: startupCandidates.length,
      enqueueCount: plannedEnqueueCount,
      skipCount: plannedSkipCount,
      decisionCounts: Object.fromEntries(planDecisionCounts),
    });

    const labelDefinitions = this.projects.getById(site.projectId)?.labelDefinitions ?? [];
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

    this.runLogs.log({
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

      this.runs.refreshCounts(runId);
      this.runs.finishRun(runId, 'succeeded');
      this.runLogs.log({
        crawlRunId: runId,
        level: 'info',
        event: 'crawl_finished',
        message: `Run ${runId} finished successfully`,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.runs.refreshCounts(runId);
      this.runs.finishRun(runId, 'failed', errorMessage);
      this.runLogs.log({
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
      pageRuns: this.pageRuns.countByRun(runId),
      artifactRuns: this.artifactRuns.countByRun(runId),
    };
  }
}
