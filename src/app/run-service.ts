import { mkdir } from 'node:fs/promises';

import { Configuration } from 'crawlee';

import { FileArtifactWriter } from '../export/file-artifact-writer.js';
import type { Classifier } from '../classification/classifier.js';
import { FakeClassifier } from '../classification/fake-classifier.js';
import { LLMClassifier } from '../classification/llm-classifier.js';
import { extractLabelDefinitionCores } from '../classification/label-definitions.js';
import type {
  ArtifactRunRepository,
  PageRunRepository,
  ProjectRepository,
  RunLogRepository,
  RunRepository,
  SitePageRepository,
  SiteRepository,
  SystemSettingRepository,
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
import { PlaywrightBrowserManager } from '../capture/browser-provider.js';
import {
  Crawl4AITool,
  DefuddleMarkdownTool,
  HttpBaseTool,
  JinaMarkdownTool,
  KickstarterCommentsAdapter,
  LightpandaMarkdownTool,
  PlaywrightScreenshotTool,
  ScraplingTool,
} from '../capture/captools/index.js';
import { CaptureProfileResolver } from '../capture/profile-resolver.js';
import { CaptureToolRegistry } from '../capture/tool-registry.js';
import { RunTargetTracker } from '../planner/run-target-tracker.js';
import { CrawleeCaptureRuntime } from '../crawlee/capture-runtime.js';
import { REQUEST_HANDLER_TIMEOUT_SECS } from '../capture/python-bridge-config.js';
import {
  createPageCaptureFailedRequestHandler,
  createPageCaptureRequestHandler,
} from '../crawlee/handlers.js';
import { RunPlanner } from '../planner/run-planner.js';
import { resolveBaseTaskNeeds } from '../planner/base-task-needs.js';
import { expandStartupUrlCandidates } from '../planner/startup-url-expander.js';

import { FeishuSimpleBot, type FeishuPostContent } from '../utils/feishu-simple-bot.js';
import { logger, openRuntimeLog, withRuntimeLog } from '../utils/runtime-logger.js';
import { isInvalidUrlError, mergeUrlNormalizationConfigs } from '../utils/url.js';

export interface RunNotificationBot {
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

export interface RunServiceOptions {
  classifier?: Classifier;
  captureTools?: CaptureTool[];
  feishuBot?: RunNotificationBot | null;
}

export class RunService {
  private readonly classifier: Classifier | null;

  private readonly captureTools: CaptureTool[] | null;

  private readonly defaultCaptureToolChain: string[];

  private runNotificationBot: RunNotificationBot | null | undefined;

  constructor(
    private readonly projects: ProjectRepository,
    private readonly sites: SiteRepository,
    private readonly runs: RunRepository,
    private readonly sitePages: SitePageRepository,
    private readonly pageRuns: PageRunRepository,
    private readonly artifactRuns: ArtifactRunRepository,
    private readonly runLogs: RunLogRepository,
    private readonly systemSettings: SystemSettingRepository,
    private readonly planner: RunPlanner,
    options: RunServiceOptions,
  ) {
    this.classifier = options.classifier ?? null;
    this.captureTools = options.captureTools ?? null;
    this.defaultCaptureToolChain = options.captureTools
      ? options.captureTools.map((tool) => tool.name)
      : ['http-base', 'defuddle-markdown', 'lightpanda-markdown', 'jina-markdown', 'playwright-screenshot'];
    this.runNotificationBot = options.feishuBot;
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

    const effectiveConfig = await this.buildEffectiveConfig(site.config, input.crawlMaxDepthOverride);

    await mkdir(site.storageRoot, { recursive: true });

    const runId = await this.runs.createRun({
      siteId: site.id,
      runType: input.runType,
      updatePolicy: input.updatePolicy,
      targetSuccessCount: input.targetSuccessCount,
      configSnapshot: effectiveConfig,
    });

    const runtimeLog = await openRuntimeLog({
      storageRoot: site.storageRoot,
      runId,
    });

    await this.runLogs.runtime_log_ready(runId, runtimeLog.relativePath);

    try {
      return await withRuntimeLog(runtimeLog, async () => {
        logger.info('Runtime log initialized', {
          runType: input.runType,
          updatePolicy: input.updatePolicy,
          siteId: site.id,
        });
        return this.executeRunWithRuntime(input, runId, effectiveConfig);
      });
    } catch (error) {
      const currentRun = await this.runs.getById(runId);

      if (currentRun?.status === 'running') {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await this.runs.refreshCounts(runId);
        await this.runs.finishRun(runId, 'failed', errorMessage);
        await this.runLogs.crawl_error(
          runId,
          errorMessage,
          { stack: error instanceof Error ? (error.stack ?? null) : null },
        );
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
  }, runId: number, effectiveConfig: SiteConfig): Promise<RunSummary> {
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

    let startupCandidates: Awaited<ReturnType<typeof expandStartupUrlCandidates>>;
    if (input.initialUrls && input.initialUrls.length > 0) {
      startupCandidates = input.initialUrls.map((url) => ({ url, discoverySource: 'inventory' as const }));
    } else {
      const knownUrls =
        input.runType === 'crawl_run'
          ? (await this.sitePages.listKnownUrls(site.id)).map((row) => row.discoveredUrl)
          : [];
      startupCandidates = await expandStartupUrlCandidates({
        seedUrls: effectiveConfig.seedUrls,
        sitemapUrls: effectiveConfig.sitemaps,
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
          await this.runLogs.sitemap_skipped(runId, sitemapUrl, error);
        },
      });
    }

    logger.info('Expanded startup URL candidates', {
      runId,
      siteId: site.id,
      candidateCount: startupCandidates.length,
    });

    const browserManager = new PlaywrightBrowserManager(effectiveConfig);
    const captureTools = this.captureTools ?? [
      new HttpBaseTool(),
      new DefuddleMarkdownTool(),
      new LightpandaMarkdownTool(browserManager),
      new JinaMarkdownTool(),
      new PlaywrightScreenshotTool(browserManager),
      new Crawl4AITool(browserManager),
      new ScraplingTool(browserManager),
      new KickstarterCommentsAdapter(),
    ];

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
        await this.runLogs.url_plan_skipped(
          runId,
          candidate.url,
          {
            reason: 'invalid_url',
            discoverySource: candidate.discoverySource,
            errorMessage: error.message,
          },
        );
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

      const history = await this.sitePages.getHistoricalState(site.id, planned.normalizedUrl);
      const captureNeeds = resolveBaseTaskNeeds({
        url: planned.normalizedUrl,
        siteConfig: effectiveConfig,
        runType: input.runType,
        updatePolicy: input.updatePolicy,
        history,
        staleAfterMs: input.staleAfterMs,
        nowIsoString: new Date().toISOString(),
        captureTools,
      });

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
          needs: captureNeeds,
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

    const toolRegistry = new CaptureToolRegistry(captureTools);
    const executor = new PageCaptureExecutor(toolRegistry, {
      profileResolver: new CaptureProfileResolver(toolRegistry, this.defaultCaptureToolChain),
    });

    const runtime = new CrawleeCaptureRuntime({
      requestQueue: pageCaptureQueue,
      configuration,
      requestHandlerTimeoutSecs: REQUEST_HANDLER_TIMEOUT_SECS,
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
        captureTools,
        targetTracker,
      }),
      failedRequestHandler: createPageCaptureFailedRequestHandler({
        artifactRunRepository: this.artifactRuns,
        pageRunRepository: this.pageRuns,
        sitePageRepository: this.sitePages,
        runLog: this.runLogs,
      }),
    });

    await this.runLogs.crawl_started(runId, {
      runType: input.runType,
      updatePolicy: input.updatePolicy,
      targetSuccessCount: input.targetSuccessCount,
      siteId: site.id,
    });

    try {
      await runtime.run();

      await this.runs.refreshCounts(runId);
      await this.runs.finishRun(runId, 'succeeded');
      await this.runLogs.crawl_finished(runId);
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
      await this.runLogs.crawl_error(
        runId,
        errorMessage,
        { stack: error instanceof Error ? (error.stack ?? null) : null },
      );
      await this.notifyRunFinished({
        runId,
        site,
        runType: input.runType,
        updatePolicy: input.updatePolicy,
        status: 'failed',
        errorMessage,
      });
      throw error;
    } finally {
      await browserManager.close();
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

  private async buildEffectiveConfig(
    siteConfig: SiteConfig,
    crawlMaxDepthOverride?: number | null,
  ): Promise<SiteConfig> {
    const systemConfig = await this.systemSettings.getSystemConfig();
    const runOptions =
      crawlMaxDepthOverride !== null && crawlMaxDepthOverride !== undefined
        ? { ...siteConfig.runOptions, crawlMaxDepth: crawlMaxDepthOverride }
        : siteConfig.runOptions;

    return {
      ...siteConfig,
      runOptions,
      urlNormalization: mergeUrlNormalizationConfigs(
        systemConfig.urlNormalization,
        siteConfig.urlNormalization,
      ),
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
        await this.runLogs.feishu_notification_failed(input.runId, errorMessage);
      } catch (logError) {
        logger.warn('Failed to record Feishu notification failure', {
          runId: input.runId,
          errorMessage: logError instanceof Error ? logError.message : String(logError),
        });
      }
    }
  }
}
