import type { RequestQueue } from 'crawlee';
import { type CheerioCrawlingContext } from 'crawlee';

import type { Classifier } from '../classification/classifier.js';
import type {
  ArtifactRunStatus,
  BaseRequestUserData,
  MarkdownRequestUserData,
  RunType,
  SiteConfig,
  UpdatePolicy,
} from '../domain/types.js';
import type { MarkdownCaptureAdapter } from '../markdown/fake-markdown-adapter.js';
import { buildStageDecision } from '../rules/rule-decision.js';
import { extractPageContent } from '../extract/extract-page.js';
import {
  ArtifactRunRepository,
  PageRunRepository,
  SitePageRepository,
} from '../db/repositories.js';
import { RunPlanner } from '../planner/run-planner.js';

function getMaxDepth(runType: RunType, siteConfig: SiteConfig): number {
  return runType === 'inventory_preview'
    ? siteConfig.runOptions.previewMaxDepth
    : siteConfig.runOptions.crawlMaxDepth;
}

export function createBaseRequestHandler(deps: {
  classifier: Classifier;
  siteConfig: SiteConfig;
  runType: RunType;
  updatePolicy: UpdatePolicy;
  staleAfterMs: number | null;
  baseQueue: RequestQueue;
  markdownQueue: RequestQueue;
  pageRunRepository: PageRunRepository;
  sitePageRepository: SitePageRepository;
  runPlanner: RunPlanner;
}) {
  return async ({ request, $ }: CheerioCrawlingContext) => {
    const userData = request.userData as BaseRequestUserData;
    const extracted = extractPageContent(request.loadedUrl ?? request.url, $);
    let classificationError: Error | null = null;

    let classification = null;

    try {
      classification = deps.classifier.classify(extracted);
    } catch (error) {
      classificationError = error instanceof Error ? error : new Error(String(error));
    }

    const decision = buildStageDecision({
      runType: deps.runType,
      siteConfig: deps.siteConfig,
      classification,
      classificationError,
    });

    const pageRunId = deps.pageRunRepository.create({
      runId: userData.runId,
      sitePageId: userData.sitePageId,
      baseCaptureStatus: 'succeeded',
      title: extracted.title,
      metaDescription: extracted.metaDescription,
      bodyText: extracted.bodyText,
      classificationTags: classification?.tags ?? {},
      tagRuleOutcome: decision.tagOutcome,
      decisionOutcome: decision.pageOutcome,
      decisionReason: decision.reason,
      pendingReason: decision.pendingReason,
      requiredArtifacts: decision.requiredArtifacts,
    });

    deps.sitePageRepository.recordBaseCapture({
      sitePageId: userData.sitePageId,
      runId: userData.runId,
      title: extracted.title,
      tagOutcome: decision.tagOutcome,
      pageOutcome: decision.pageOutcome,
      pendingReason: decision.pendingReason,
    });

    if (
      deps.runType === 'crawl_run' &&
      decision.pageOutcome === 'allow' &&
      decision.requiredArtifacts.includes('markdown')
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
}) {
  return async ({ request }: { request: { url: string; userData: unknown } }) => {
    const userData = request.userData as MarkdownRequestUserData;
    const content = await deps.markdownAdapter.capture(request.url);

    deps.artifactRunRepository.create({
      runId: userData.runId,
      pageRunId: userData.pageRunId,
      sitePageId: userData.sitePageId,
      artifactType: 'markdown',
      status: 'succeeded',
      content,
      outputPath: null,
      errorMessage: null,
    });

    deps.sitePageRepository.recordMarkdownResult({
      sitePageId: userData.sitePageId,
      runId: userData.runId,
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
    });

    deps.sitePageRepository.recordMarkdownResult({
      sitePageId: userData.sitePageId,
      runId: userData.runId,
      status: 'failed',
    });
  };
}
