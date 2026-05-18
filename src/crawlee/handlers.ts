import type { RequestQueue } from 'crawlee';
import { type CheerioCrawlingContext } from 'crawlee';
import type { Page } from 'playwright';

import type { FileArtifactWriter } from '../export/file-artifact-writer.js';
import type { Classifier } from '../classification/classifier.js';
import type {
  ArtifactRunStatus,
  BaseRequestUserData,
  MarkdownRequestUserData,
  RunType,
  ScreenshotRequestUserData,
  SiteConfig,
  UpdatePolicy,
} from '../domain/types.js';
import type { MarkdownCaptureAdapter } from '../markdown/markdown-adapter.js';
import { extractPageContent } from '../extract/extract-page.js';
import {
  ArtifactRunRepository,
  PageRunRepository,
  RunLogRepository,
  SitePageRepository,
} from '../db/repositories/index.js';
import { RunPlanner } from '../planner/run-planner.js';
import { shouldEnqueueArtifactByUpdatePolicy } from '../planner/update-policy.js';
import { buildStage2EnqueueDecision } from '../rules/rule-decision.js';
import type { ScreenshotCaptureAdapter } from '../screenshot/screenshot-adapter.js';
import { logger } from '../utils/runtime-logger.js';
import { isInvalidUrlError } from '../utils/url.js';
import type { RunTargetTracker } from './run-target-tracker.js';

type MarkdownRequestUserDataWithState = MarkdownRequestUserData & {
  markdownRequestHandlerStarted?: boolean;
};

function getMaxDepth(runType: RunType, siteConfig: SiteConfig): number {
  return runType === 'seed_run'
    ? siteConfig.runOptions.seedMaxDepth
    : siteConfig.runOptions.crawlMaxDepth;
}

function renderBaseCaptureMarkdown(input: {
  url: string;
  title: string;
  metaDescription: string;
  bodyText: string;
}): string {
  return [
    '# Base capture',
    '',
    `Source: ${input.url}`,
    '',
    `Title: ${input.title || '(empty)'}`,
    '',
    `Meta description: ${input.metaDescription || '(empty)'}`,
    '',
    '## Body text',
    '',
    input.bodyText || '(empty)',
    '',
  ].join('\n');
}

export function createBaseRequestHandler(deps: {
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
}) {
  return async ({ request, $ }: CheerioCrawlingContext) => {
    const userData = request.userData as BaseRequestUserData;

    if (deps.targetTracker?.isReached()) {
      await deps.runLog.log({
        crawlRunId: userData.runId,
        level: 'info',
        event: 'base_page_skipped_target_reached',
        url: userData.normalizedUrl,
        sitePageId: userData.sitePageId,
        message: `[base] SKIPPED target reached ${userData.normalizedUrl}`,
        meta: {
          candidateSuccessCount: deps.targetTracker.getCandidateSuccessCount(),
        },
      });
      return;
    }

    const extracted = extractPageContent(request.loadedUrl ?? request.url, $);
    const historyBeforeCapture = await deps.sitePageRepository.getHistoricalState(
      userData.siteId,
      extracted.normalizedUrl,
    );
    let classificationError: Error | null = null;

    let classification = null;

    try {
      classification = await deps.classifier.classify(extracted);
    } catch (error) {
      classificationError = error instanceof Error ? error : new Error(String(error));
      logger.error('Base page classification failed', {
        runId: userData.runId,
        siteId: userData.siteId,
        sitePageId: userData.sitePageId,
        requestUrl: request.url,
        loadedUrl: request.loadedUrl ?? null,
        normalizedUrl: extracted.normalizedUrl,
        title: extracted.title || null,
        errorName: classificationError.name,
        errorMessage: classificationError.message,
        stack: classificationError.stack ?? null,
      });
    }

    const decision = buildStage2EnqueueDecision({
      runType: deps.runType,
      url: extracted.normalizedUrl,
      siteConfig: deps.siteConfig,
      classification,
      classificationError,
    });
    const baseCapture = await deps.artifactWriter.writeBaseCapture({
      runId: userData.runId,
      sitePageId: userData.sitePageId,
      content: renderBaseCaptureMarkdown({
        url: extracted.normalizedUrl,
        title: extracted.title,
        metaDescription: extracted.metaDescription,
        bodyText: extracted.bodyText,
      }),
    });

    const pageRunId = await deps.pageRunRepository.create({
      runId: userData.runId,
      sitePageId: userData.sitePageId,
      baseCaptureStatus: 'succeeded',
      baseCapturePath: baseCapture.outputPath,
      title: extracted.title,
      metaDescription: extracted.metaDescription,
      bodyText: extracted.bodyText,
      classificationLabels: classification?.labels ?? {},
      ruleOutcome: decision.ruleOutcome,
      decisionOutcome: decision.pageOutcome,
      decisionReason: decision.reason,
      pendingReason: decision.pendingReason,
      requiredArtifacts: decision.requiredArtifacts,
    });

    await deps.runLog.log({
      crawlRunId: userData.runId,
      level: 'info',
      event: 'base_page_done',
      url: extracted.normalizedUrl,
      sitePageId: userData.sitePageId,
      pageRunId,
      message: `[base] ${decision.pageOutcome.toUpperCase()} ${extracted.normalizedUrl}`,
      meta: {
        outcome: decision.pageOutcome,
        reason: decision.reason ?? null,
        requiredArtifacts: decision.requiredArtifacts,
        title: extracted.title || null,
      },
    });

    await deps.sitePageRepository.recordBaseCapture({
      sitePageId: userData.sitePageId,
      runId: userData.runId,
      title: extracted.title,
      pageOutcome: decision.pageOutcome,
      requiredArtifacts: decision.requiredArtifacts,
      pendingReason: decision.pendingReason,
    });

    const isTargetSuccessCandidate =
      decision.pageOutcome === 'allow' ||
      (deps.runType === 'seed_run' && decision.pendingReason === 'seed_run');

    if (isTargetSuccessCandidate) {
      const targetState = deps.targetTracker?.recordCandidateSuccess();

      if (targetState?.reachedNow) {
        await deps.runLog.log({
          crawlRunId: userData.runId,
          level: 'info',
          event: 'target_success_count_reached',
          url: extracted.normalizedUrl,
          sitePageId: userData.sitePageId,
          pageRunId,
          message: `Run ${userData.runId} reached targetSuccessCount=${targetState.target}`,
          meta: {
            targetSuccessCount: targetState.target,
            candidateSuccessCount: targetState.count,
          },
        });
      }
    }

    if (deps.runType === 'crawl_run' && decision.pageOutcome === 'allow') {
      if (
        decision.requiredArtifacts.includes('markdown') &&
        shouldEnqueueArtifactByUpdatePolicy({
          policy: deps.updatePolicy,
          history: historyBeforeCapture,
          artifactType: 'markdown',
          nowIsoString: new Date().toISOString(),
          staleAfterMs: deps.staleAfterMs,
        })
      ) {
        await deps.markdownQueue.addRequest({
          url: extracted.normalizedUrl,
          uniqueKey: `markdown:${userData.runId}:${userData.sitePageId}`,
          userData: {
            stage: 'markdown',
            runId: userData.runId,
            siteId: userData.siteId,
            sitePageId: userData.sitePageId,
            pageRunId,
            normalizedUrl: extracted.normalizedUrl,
          } satisfies MarkdownRequestUserData,
        });
      }

      if (
        decision.requiredArtifacts.includes('screenshot') &&
        shouldEnqueueArtifactByUpdatePolicy({
          policy: deps.updatePolicy,
          history: historyBeforeCapture,
          artifactType: 'screenshot',
          nowIsoString: new Date().toISOString(),
          staleAfterMs: deps.staleAfterMs,
        })
      ) {
        await deps.screenshotQueue.addRequest({
          url: extracted.normalizedUrl,
          uniqueKey: `screenshot:${userData.runId}:${userData.sitePageId}`,
          userData: {
            stage: 'screenshot',
            runId: userData.runId,
            siteId: userData.siteId,
            sitePageId: userData.sitePageId,
            pageRunId,
            normalizedUrl: extracted.normalizedUrl,
          } satisfies ScreenshotRequestUserData,
        });
      }
    }

    if (deps.targetTracker?.isReached()) {
      return;
    }

    if (userData.depth >= getMaxDepth(deps.runType, deps.siteConfig)) {
      return;
    }

    for (const link of extracted.links) {
      const plannedRequest = await deps.runPlanner.planRequest({
        siteId: userData.siteId,
        discoveredUrl: link,
        discoverySource: 'page_link',
        discoveryReferrerUrl: extracted.normalizedUrl,
        siteConfig: deps.siteConfig,
        runType: deps.runType,
        updatePolicy: deps.updatePolicy,
        staleAfterMs: deps.staleAfterMs,
      }).catch(async (error) => {
        if (!isInvalidUrlError(error)) {
          throw error;
        }

        logger.warn('Skipped invalid discovered URL', {
          runId: userData.runId,
          siteId: userData.siteId,
          discoveredUrl: link,
          referrerUrl: extracted.normalizedUrl,
          errorMessage: error.message,
        });
        await deps.runLog.log({
          crawlRunId: userData.runId,
          level: 'warn',
          event: 'url_plan_skipped',
          url: link,
          sitePageId: userData.sitePageId,
          pageRunId,
          message: `[plan] SKIPPED invalid URL ${link}`,
          meta: {
            reason: 'invalid_url',
            discoverySource: 'page_link',
            discoveryReferrerUrl: extracted.normalizedUrl,
            errorMessage: error.message,
          },
        });
        return null;
      });

      if (plannedRequest === null) {
        continue;
      }

      if (!plannedRequest.enqueue) {
        continue;
      }

      await deps.baseQueue.addRequest({
        url: link,
        uniqueKey: `base:${userData.runId}:${plannedRequest.sitePageId}`,
        userData: {
          stage: 'base',
          runId: userData.runId,
          siteId: userData.siteId,
          sitePageId: plannedRequest.sitePageId,
          normalizedUrl: plannedRequest.normalizedUrl,
          depth: userData.depth + 1,
          runType: deps.runType,
        } satisfies BaseRequestUserData,
      });
    }
  };
}

export function createBaseFailedRequestHandler(deps: {
  pageRunRepository: PageRunRepository;
  sitePageRepository: SitePageRepository;
  runLog: RunLogRepository;
}) {
  return async (
    { request }: { request: { url: string; userData: unknown } },
    error: Error,
  ) => {
    const userData = request.userData as BaseRequestUserData;

    await deps.pageRunRepository.createFailed({
      runId: userData.runId,
      sitePageId: userData.sitePageId,
      errorMessage: error.message,
    });

    await deps.sitePageRepository.recordBaseCaptureFailed({
      runId: userData.runId,
      sitePageId: userData.sitePageId,
    });

    await deps.runLog.log({
      crawlRunId: userData.runId,
      level: 'error',
      event: 'base_page_failed',
      url: request.url,
      sitePageId: userData.sitePageId,
      message: `[base] FAILED ${request.url}: ${error.message}`,
      meta: { stack: error.stack ?? null },
    });
  };
}

async function captureAndRecordMarkdown(input: {
  requestUrl: string;
  finalUrl: string;
  document?: Document;
  userData: MarkdownRequestUserData;
  markdownAdapter: MarkdownCaptureAdapter;
  artifactRunRepository: ArtifactRunRepository;
  sitePageRepository: SitePageRepository;
  artifactWriter: FileArtifactWriter;
  runLog: RunLogRepository;
}) {
  const captured = await input.markdownAdapter.capture(input.requestUrl, {
    document: input.document,
    finalUrl: input.finalUrl,
  });
  const written = await input.artifactWriter.writeTextArtifact({
    artifactType: 'markdown',
    runId: input.userData.runId,
    sitePageId: input.userData.sitePageId,
    content: captured.content,
    extension: 'md',
  });

  await input.artifactRunRepository.create({
    runId: input.userData.runId,
    pageRunId: input.userData.pageRunId,
    sitePageId: input.userData.sitePageId,
    artifactType: 'markdown',
    status: 'succeeded',
    content: written.content,
    outputPath: written.outputPath,
    errorMessage: null,
    meta: { strategy: captured.strategyName },
  });

  await input.runLog.log({
    crawlRunId: input.userData.runId,
    level: 'info',
    event: 'artifact_done',
    url: input.userData.normalizedUrl,
    sitePageId: input.userData.sitePageId,
    pageRunId: input.userData.pageRunId,
    message: `[markdown] done ${input.userData.normalizedUrl}`,
    meta: { strategy: captured.strategyName, outputPath: written.outputPath },
  });

  await input.sitePageRepository.recordArtifactResult({
    sitePageId: input.userData.sitePageId,
    runId: input.userData.runId,
    artifactType: 'markdown',
    status: 'succeeded',
  });
}

export function createMarkdownRequestHandler(deps: {
  markdownAdapter: MarkdownCaptureAdapter;
  artifactRunRepository: ArtifactRunRepository;
  sitePageRepository: SitePageRepository;
  artifactWriter: FileArtifactWriter;
  runLog: RunLogRepository;
}) {
  return async (context: {
    request: { url: string; userData: unknown; loadedUrl?: string };
    document?: Document;
  }) => {
    const { request } = context;
    const userData = request.userData as MarkdownRequestUserDataWithState;
    userData.markdownRequestHandlerStarted = true;

    await captureAndRecordMarkdown({
      requestUrl: request.url,
      finalUrl: request.loadedUrl ?? request.url,
      document: context.document,
      userData,
      markdownAdapter: deps.markdownAdapter,
      artifactRunRepository: deps.artifactRunRepository,
      sitePageRepository: deps.sitePageRepository,
      artifactWriter: deps.artifactWriter,
      runLog: deps.runLog,
    });
  };
}

export function createMarkdownFailedRequestHandler(deps: {
  markdownAdapter?: MarkdownCaptureAdapter;
  artifactRunRepository: ArtifactRunRepository;
  sitePageRepository: SitePageRepository;
  artifactWriter?: FileArtifactWriter;
  runLog: RunLogRepository;
}) {
  return async (
    { request }: { request: { url?: string; userData: unknown; loadedUrl?: string } },
    error: Error,
  ) => {
    const userData = request.userData as MarkdownRequestUserDataWithState;
    let finalError = error;

    if (
      deps.markdownAdapter &&
      deps.artifactWriter &&
      request.url &&
      !userData.markdownRequestHandlerStarted
    ) {
      try {
        await captureAndRecordMarkdown({
          requestUrl: request.url,
          finalUrl: request.loadedUrl ?? request.url,
          userData,
          markdownAdapter: deps.markdownAdapter,
          artifactRunRepository: deps.artifactRunRepository,
          sitePageRepository: deps.sitePageRepository,
          artifactWriter: deps.artifactWriter,
          runLog: deps.runLog,
        });
        return;
      } catch (fallbackError) {
        const fallbackMessage =
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        finalError = new Error(
          `${error.message}; URL-only markdown fallback failed: ${fallbackMessage}`,
        );
      }
    }

    await deps.artifactRunRepository.create({
      runId: userData.runId,
      pageRunId: userData.pageRunId,
      sitePageId: userData.sitePageId,
      artifactType: 'markdown',
      status: 'failed' satisfies ArtifactRunStatus,
      content: null,
      outputPath: null,
      errorMessage: finalError.message,
      meta: null,
    });

    await deps.runLog.log({
      crawlRunId: userData.runId,
      level: 'error',
      event: 'artifact_failed',
      url: userData.normalizedUrl,
      sitePageId: userData.sitePageId,
      pageRunId: userData.pageRunId,
      message: `[markdown] FAILED ${userData.normalizedUrl}: ${finalError.message}`,
      meta: { stack: finalError.stack ?? null },
    });

    await deps.sitePageRepository.recordArtifactResult({
      sitePageId: userData.sitePageId,
      runId: userData.runId,
      artifactType: 'markdown',
      status: 'failed',
    });
  };
}

export function createScreenshotRequestHandler(deps: {
  screenshotAdapter: ScreenshotCaptureAdapter;
  artifactRunRepository: ArtifactRunRepository;
  sitePageRepository: SitePageRepository;
  artifactWriter: FileArtifactWriter;
  runLog: RunLogRepository;
}) {
  return async (context: {
    request: { url: string; userData: unknown; loadedUrl?: string };
    page?: Page;
  }) => {
    const { request } = context;
    const userData = request.userData as ScreenshotRequestUserData;
    const capture = await deps.screenshotAdapter.capture(request.url, {
      page: context.page,
      finalUrl: request.loadedUrl ?? request.url,
    });
    const written = await deps.artifactWriter.writeBinaryArtifact({
      artifactType: 'screenshot',
      runId: userData.runId,
      sitePageId: userData.sitePageId,
      content: capture.data,
      extension: capture.extension,
    });

    await deps.artifactRunRepository.create({
      runId: userData.runId,
      pageRunId: userData.pageRunId,
      sitePageId: userData.sitePageId,
      artifactType: 'screenshot',
      status: 'succeeded',
      content: written.content,
      outputPath: written.outputPath,
      errorMessage: null,
      meta: { tool: capture.toolName },
    });

    await deps.runLog.log({
      crawlRunId: userData.runId,
      level: 'info',
      event: 'artifact_done',
      url: userData.normalizedUrl,
      sitePageId: userData.sitePageId,
      pageRunId: userData.pageRunId,
      message: `[screenshot] done ${userData.normalizedUrl}`,
      meta: { tool: capture.toolName, outputPath: written.outputPath },
    });

    await deps.sitePageRepository.recordArtifactResult({
      sitePageId: userData.sitePageId,
      runId: userData.runId,
      artifactType: 'screenshot',
      status: 'succeeded',
    });
  };
}

export function createScreenshotFailedRequestHandler(deps: {
  artifactRunRepository: ArtifactRunRepository;
  sitePageRepository: SitePageRepository;
  runLog: RunLogRepository;
}) {
  return async ({ request }: { request: { userData: unknown } }, error: Error) => {
    const userData = request.userData as ScreenshotRequestUserData;

    await deps.artifactRunRepository.create({
      runId: userData.runId,
      pageRunId: userData.pageRunId,
      sitePageId: userData.sitePageId,
      artifactType: 'screenshot',
      status: 'failed' satisfies ArtifactRunStatus,
      content: null,
      outputPath: null,
      errorMessage: error.message,
      meta: null,
    });

    await deps.runLog.log({
      crawlRunId: userData.runId,
      level: 'error',
      event: 'artifact_failed',
      url: userData.normalizedUrl,
      sitePageId: userData.sitePageId,
      pageRunId: userData.pageRunId,
      message: `[screenshot] FAILED ${userData.normalizedUrl}: ${error.message}`,
      meta: { stack: error.stack ?? null },
    });

    await deps.sitePageRepository.recordArtifactResult({
      sitePageId: userData.sitePageId,
      runId: userData.runId,
      artifactType: 'screenshot',
      status: 'failed',
    });
  };
}
