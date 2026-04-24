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
  SitePageRepository,
} from '../db/repositories.js';
import { RunPlanner } from '../planner/run-planner.js';
import { shouldEnqueueArtifactByUpdatePolicy } from '../planner/update-policy.js';
import { buildStage2EnqueueDecision } from '../rules/rule-decision.js';
import type { ScreenshotCaptureAdapter } from '../screenshot/screenshot-adapter.js';

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
}) {
  return async ({ request, $ }: CheerioCrawlingContext) => {
    const userData = request.userData as BaseRequestUserData;
    const extracted = extractPageContent(request.loadedUrl ?? request.url, $);
    const historyBeforeCapture = deps.sitePageRepository.getHistoricalState(
      userData.siteId,
      extracted.normalizedUrl,
    );
    let classificationError: Error | null = null;

    let classification = null;

    try {
      classification = deps.classifier.classify(extracted);
    } catch (error) {
      classificationError = error instanceof Error ? error : new Error(String(error));
    }

    const decision = buildStage2EnqueueDecision({
      runType: deps.runType,
      url: extracted.normalizedUrl,
      siteConfig: deps.siteConfig,
      classification,
      classificationError,
    });
    const baseCapture = deps.artifactWriter.writeBaseCapture({
      runId: userData.runId,
      sitePageId: userData.sitePageId,
      content: renderBaseCaptureMarkdown({
        url: extracted.normalizedUrl,
        title: extracted.title,
        metaDescription: extracted.metaDescription,
        bodyText: extracted.bodyText,
      }),
    });

    const pageRunId = deps.pageRunRepository.create({
      runId: userData.runId,
      sitePageId: userData.sitePageId,
      baseCaptureStatus: 'succeeded',
      baseCapturePath: baseCapture.outputPath,
      title: extracted.title,
      metaDescription: extracted.metaDescription,
      bodyText: extracted.bodyText,
      classificationTags: classification?.tags ?? {},
      ruleOutcome: decision.ruleOutcome,
      decisionOutcome: decision.pageOutcome,
      decisionReason: decision.reason,
      pendingReason: decision.pendingReason,
      requiredArtifacts: decision.requiredArtifacts,
    });

    deps.sitePageRepository.recordBaseCapture({
      sitePageId: userData.sitePageId,
      runId: userData.runId,
      title: extracted.title,
      pageOutcome: decision.pageOutcome,
      requiredArtifacts: decision.requiredArtifacts,
      pendingReason: decision.pendingReason,
    });

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

    if (userData.depth >= getMaxDepth(deps.runType, deps.siteConfig)) {
      return;
    }

    for (const link of extracted.links) {
      const plannedRequest = deps.runPlanner.planRequest({
        siteId: userData.siteId,
        discoveredUrl: link,
        discoverySource: 'page_link',
        discoveryReferrerUrl: extracted.normalizedUrl,
        siteConfig: deps.siteConfig,
        runType: deps.runType,
        updatePolicy: deps.updatePolicy,
        staleAfterMs: deps.staleAfterMs,
      });

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

export function createMarkdownRequestHandler(deps: {
  markdownAdapter: MarkdownCaptureAdapter;
  artifactRunRepository: ArtifactRunRepository;
  sitePageRepository: SitePageRepository;
  artifactWriter: FileArtifactWriter;
}) {
  return async (context: {
    request: { url: string; userData: unknown; loadedUrl?: string };
    document?: Document;
  }) => {
    const { request } = context;
    const userData = request.userData as MarkdownRequestUserData;
    const captured = await deps.markdownAdapter.capture(request.url, {
      document: context.document,
      finalUrl: request.loadedUrl ?? request.url,
    });
    const written = deps.artifactWriter.writeTextArtifact({
      artifactType: 'markdown',
      runId: userData.runId,
      sitePageId: userData.sitePageId,
      content: captured.content,
      extension: 'md',
    });

    deps.artifactRunRepository.create({
      runId: userData.runId,
      pageRunId: userData.pageRunId,
      sitePageId: userData.sitePageId,
      artifactType: 'markdown',
      status: 'succeeded',
      content: written.content,
      outputPath: written.outputPath,
      errorMessage: null,
      meta: { strategy: captured.strategyName },
    });

    deps.sitePageRepository.recordArtifactResult({
      sitePageId: userData.sitePageId,
      runId: userData.runId,
      artifactType: 'markdown',
      status: 'succeeded',
    });
  };
}

export function createMarkdownFailedRequestHandler(deps: {
  artifactRunRepository: ArtifactRunRepository;
  sitePageRepository: SitePageRepository;
}) {
  return async ({ request }: { request: { userData: unknown } }, error: Error) => {
    const userData = request.userData as MarkdownRequestUserData;

    deps.artifactRunRepository.create({
      runId: userData.runId,
      pageRunId: userData.pageRunId,
      sitePageId: userData.sitePageId,
      artifactType: 'markdown',
      status: 'failed' satisfies ArtifactRunStatus,
      content: null,
      outputPath: null,
      errorMessage: error.message,
      meta: null,
    });

    deps.sitePageRepository.recordArtifactResult({
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
    const written = deps.artifactWriter.writeBinaryArtifact({
      artifactType: 'screenshot',
      runId: userData.runId,
      sitePageId: userData.sitePageId,
      content: capture.data,
      extension: capture.extension,
    });

    deps.artifactRunRepository.create({
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

    deps.sitePageRepository.recordArtifactResult({
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
}) {
  return async ({ request }: { request: { userData: unknown } }, error: Error) => {
    const userData = request.userData as ScreenshotRequestUserData;

    deps.artifactRunRepository.create({
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

    deps.sitePageRepository.recordArtifactResult({
      sitePageId: userData.sitePageId,
      runId: userData.runId,
      artifactType: 'screenshot',
      status: 'failed',
    });
  };
}
