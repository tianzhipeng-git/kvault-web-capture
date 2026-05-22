import { mkdir } from 'node:fs/promises';

import { Configuration } from 'crawlee';

import { FileArtifactWriter } from '../export/file-artifact-writer.js';
import {
  ProjectExporter,
  type ProjectExportOptions,
  type ProjectExportResult,
  type SitePageIdExportInput,
  type SitePageIdExportResult,
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
  PageCaptureTask,
  RunType,
  RunSummary,
  SiteConfig,
  UpdatePolicy,
} from '../domain/types.js';
import { openRunQueue } from '../crawlee/queue-factory.js';
import { PageCaptureExecutor } from '../capture/executor.js';
import type { CaptureTool } from '../capture/types.js';
import { HttpBaseTool, MarkdownTool, PlaywrightScreenshotTool } from '../capture/captools/index.js';
import { RunTargetTracker } from '../planner/run-target-tracker.js';
import { CrawleeCaptureRuntime } from '../crawlee/capture-runtime.js';
import {
  createPageCaptureFailedRequestHandler,
  createPageCaptureRequestHandler,
} from '../crawlee/handlers.js';
import { RunPlanner } from '../planner/run-planner.js';
import { expandStartupUrlCandidates } from '../planner/startup-url-expander.js';

import { SystemClock } from '../utils/clock.js';
import { FeishuSimpleBot, type FeishuPostContent } from '../utils/feishu-simple-bot.js';
import { logger, openRuntimeLog, withRuntimeLog } from '../utils/runtime-logger.js';
import { isInvalidUrlError } from '../utils/url.js';
import { buildPathTree, type PathTreeResult } from '../utils/path-tree.js';

interface RunNotificationBot {
  sendPost(title: string, content: FeishuPostContent, lang?: string): Promise<unknown>;
}

interface RunNotificationInput {
  runId: number;
  site: {
    id: number;
    name: string;
    baseUrl: string;
  };
  runType: RunType;
  updatePolicy: UpdatePolicy;
  status: 'succeeded' | 'failed';
  errorMessage?: string;
}

export interface M1AppOptions {
  dbPath: string;
  databaseUrl?: string;
  classifier?: Classifier;
  captureTools?: CaptureTool[];
  feishuBot?: RunNotificationBot | null;
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

  private readonly captureTools: CaptureTool[];

  private runNotificationBot: RunNotificationBot | null | undefined;

  private constructor(private readonly options: M1AppOptions) {
    this.clock = new SystemClock();
    this.classifier = options.classifier ?? null;
    this.captureTools = options.captureTools ?? [
      new HttpBaseTool(),
      new MarkdownTool(),
      new PlaywrightScreenshotTool(),
    ];
    this.runNotificationBot = options.feishuBot;
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

  async getSitePathTree(siteId: number): Promise<PathTreeResult> {
    const site = await this.sites.getById(siteId);

    if (!site) {
      throw new Error(`Site ${siteId} not found`);
    }

    return buildPathTree((await this.sitePages.listKnownUrls(siteId)).map((row) => row.normalizedUrl));
  }

  async listSampleCaptures(siteId: number, limit: number): Promise<SampleCaptureRow[]> {
    return this.pageRuns.listSampleCaptures(siteId, limit);
  }

  exportProject(
    projectId: number,
    outputPath?: string,
    options?: ProjectExportOptions,
  ): Promise<ProjectExportResult> {
    return this.projectExporter.exportProject({ projectId, outputPath, options });
  }

  exportSitePageList(input: SitePageListExportInput): Promise<SitePageListExportResult> {
    return this.projectExporter.exportSitePageList(input);
  }

  exportSitePagesByIds(input: SitePageIdExportInput): Promise<SitePageIdExportResult> {
    return this.projectExporter.exportSitePagesByIds(input);
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

    await mkdir(site.storageRoot, { recursive: true });

    const runId = await this.runs.createRun({
      siteId: site.id,
      runType: input.runType,
      updatePolicy: input.updatePolicy,
      targetSuccessCount: input.targetSuccessCount,
      configSnapshot: site.config,
    });

    const runtimeLog = await openRuntimeLog({
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
    } catch (error) {
      const currentRun = await this.runs.getById(runId);

      if (currentRun?.status === 'running') {
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
        logger.error('Run failed before completion', {
          runId,
          siteId: site.id,
          runType: input.runType,
          updatePolicy: input.updatePolicy,
          errorName: error instanceof Error ? error.name : null,
          errorMessage,
          stack: error instanceof Error ? (error.stack ?? null) : null,
        });
        await this.notifyRunFinished({
          runId,
          site,
          runType: input.runType,
          updatePolicy: input.updatePolicy,
          status: 'failed',
          errorMessage,
        });
      }

      throw error;
    } finally {
      await runtimeLog.close();
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
    const pageCaptureQueue = await openRunQueue(runId, 'page-capture', configuration);
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
        onSitemapError: async ({ sitemapUrl, error }) => {
          logger.warn('Skipped sitemap during startup expansion', {
            runId,
            siteId: site.id,
            sitemapUrl,
            errorName: error.name,
            errorMessage: error.message,
            stack: error.stack ?? null,
          });
          await this.runLogs.log({
            crawlRunId: runId,
            level: 'warn',
            event: 'sitemap_skipped',
            url: sitemapUrl,
            message: `[startup] SKIPPED sitemap ${sitemapUrl}: ${error.message}`,
            meta: {
              reason: 'sitemap_fetch_failed',
              errorName: error.name,
              errorMessage: error.message,
              stack: error.stack ?? null,
            },
          });
        },
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
      }).catch(async (error) => {
        if (!isInvalidUrlError(error)) {
          throw error;
        }

        plannedSkipCount += 1;
        planDecisionCounts.set(
          'invalid_url',
          (planDecisionCounts.get('invalid_url') ?? 0) + 1,
        );
        logger.warn('Skipped invalid startup URL candidate', {
          runId,
          siteId: site.id,
          discoveredUrl: candidate.url,
          discoverySource: candidate.discoverySource,
          errorMessage: error.message,
        });
        await this.runLogs.log({
          crawlRunId: runId,
          level: 'warn',
          event: 'url_plan_skipped',
          url: candidate.url,
          message: `[plan] SKIPPED invalid URL ${candidate.url}`,
          meta: {
            reason: 'invalid_url',
            discoverySource: candidate.discoverySource,
            errorMessage: error.message,
          },
        });
        return null;
      });

      if (planned === null) {
        continue;
      }

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

      await pageCaptureQueue.addRequest({
        url: candidate.url,
        uniqueKey: `base:${runId}:${planned.sitePageId}`,
        userData: {
          stage: 'page_capture',
          runId,
          siteId: site.id,
          sitePageId: planned.sitePageId,
          normalizedUrl: planned.normalizedUrl,
          url: candidate.url,
          depth: 0,
          needs: ['base'],
          purpose: 'discovery',
        } satisfies PageCaptureTask,
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

    const executor = new PageCaptureExecutor(this.captureTools);

    const runtime = new CrawleeCaptureRuntime({
      requestQueue: pageCaptureQueue,
      configuration,
      requestHandler: createPageCaptureRequestHandler({
        executor,
        classifier,
        siteConfig: effectiveConfig,
        runType: input.runType,
        updatePolicy: input.updatePolicy,
        staleAfterMs: input.staleAfterMs,
        pageCaptureQueue,
        artifactWriter,
        artifactRunRepository: this.artifactRuns,
        pageRunRepository: this.pageRuns,
        sitePageRepository: this.sitePages,
        runPlanner: this.planner,
        runLog: this.runLogs,
        targetTracker,
      }),
      failedRequestHandler: createPageCaptureFailedRequestHandler({
        artifactRunRepository: this.artifactRuns,
        pageRunRepository: this.pageRuns,
        sitePageRepository: this.sitePages,
        runLog: this.runLogs,
      }),
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
      await runtime.run();

      await this.runs.refreshCounts(runId);
      await this.runs.finishRun(runId, 'succeeded');
      await this.runLogs.log({
        crawlRunId: runId,
        level: 'info',
        event: 'crawl_finished',
        message: `Run ${runId} finished successfully`,
      });
      await this.notifyRunFinished({
        runId,
        site,
        runType: input.runType,
        updatePolicy: input.updatePolicy,
        status: 'succeeded',
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
      await this.notifyRunFinished({
        runId,
        site,
        runType: input.runType,
        updatePolicy: input.updatePolicy,
        status: 'failed',
        errorMessage,
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

  private getRunNotificationBot(): RunNotificationBot | null {
    if (this.runNotificationBot !== undefined) {
      return this.runNotificationBot;
    }

    if (!process.env.FEISHU_BOT_WEBHOOK_ID) {
      this.runNotificationBot = null;
      return null;
    }

    this.runNotificationBot = new FeishuSimpleBot();
    return this.runNotificationBot;
  }

  private async notifyRunFinished(input: RunNotificationInput): Promise<void> {
    try {
      const bot = this.getRunNotificationBot();

      if (!bot) {
        return;
      }

      const statusLabel = input.status === 'succeeded' ? '成功' : '失败';
      const pageRuns = await this.pageRuns.countByRun(input.runId);
      const artifactRuns = await this.artifactRuns.countByRun(input.runId);
      const content: FeishuPostContent = [
        [{ tag: 'text', text: `状态: ${statusLabel}` }],
        [{ tag: 'text', text: `Run ID: ${input.runId}` }],
        [{ tag: 'text', text: `站点: ${input.site.name} (#${input.site.id})` }],
        [{ tag: 'text', text: `Base URL: ${input.site.baseUrl}` }],
        [{ tag: 'text', text: `类型: ${input.runType}` }],
        [{ tag: 'text', text: `更新策略: ${input.updatePolicy}` }],
        [{ tag: 'text', text: `页面记录: ${pageRuns}` }],
        [{ tag: 'text', text: `产物记录: ${artifactRuns}` }],
      ];

      if (input.errorMessage) {
        content.push([{ tag: 'text', text: `错误: ${input.errorMessage.slice(0, 800)}` }]);
      }

      await bot.sendPost(
        `kvault-web-capture run ${statusLabel}: #${input.runId} ${input.site.name}`,
        content,
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn('Feishu run notification failed', {
        runId: input.runId,
        siteId: input.site.id,
        status: input.status,
        errorMessage,
      });
      try {
        await this.runLogs.log({
          crawlRunId: input.runId,
          level: 'warn',
          event: 'feishu_notification_failed',
          message: `Feishu notification failed for run ${input.runId}: ${errorMessage}`,
        });
      } catch (logError) {
        logger.warn('Failed to record Feishu notification failure', {
          runId: input.runId,
          errorMessage: logError instanceof Error ? logError.message : String(logError),
        });
      }
    }
  }
}
