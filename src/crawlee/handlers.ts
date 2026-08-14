import type { RequestQueue } from 'crawlee';

import type { PageCaptureExecutor } from '../capture/executor.js';
import { formatToolFallbackSummary } from '../capture/diagnostics-utils.js';
import type { CaptureResult, CaptureTool, RuntimeContext } from '../capture/types.js';
import type { FileArtifactWriter } from '../export/file-artifact-writer.js';
import type { Classifier } from '../classification/classifier.js';
import type {
  ArtifactRunStatus,
  ArtifactRequirement,
  ArtifactType,
  PageCaptureTask,
  RunType,
  SiteConfig,
  UpdatePolicy,
} from '../domain/types.js';
import {
  defaultArtifactRequirement,
  expandArtifactRequirements,
} from '../domain/artifact-requirements.js';
import {
  ArtifactRunRepository,
  PageRunRepository,
  RunLogRepository,
  SitePageRepository,
} from '../db/repositories/index.js';
import { RunPlanner } from '../planner/run-planner.js';
import { resolveBaseTaskNeeds } from '../planner/base-task-needs.js';
import type { RunTargetTracker } from '../planner/run-target-tracker.js';
import { shouldEnqueueArtifactByUpdatePolicy } from '../planner/update-policy.js';
import { buildStage2EnqueueDecision } from '../rules/rule-decision.js';
import { logger } from '../utils/runtime-logger.js';
import { isInvalidUrlError } from '../utils/url.js';

function getMaxDepth(runType: RunType, siteConfig: SiteConfig): number {
  return runType === 'seed_run'
    ? siteConfig.runOptions.seedMaxDepth
    : siteConfig.runOptions.crawlMaxDepth;
}

function artifactNeeds(needs: PageCaptureTask['needs']): ArtifactType[] {
  return needs.filter((need): need is ArtifactType => (
    need === 'markdown' || need === 'screenshot' || need === 'structured'
  ));
}

function captureResultHasArtifact(result: CaptureResult, artifactType: ArtifactType): boolean {
  return artifactType === 'markdown'
    ? result.markdown !== undefined
    : artifactType === 'screenshot'
      ? result.screenshot !== undefined
      : result.structured !== undefined;
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

function buildTask(input: {
  runId: number;
  siteId: number;
  sitePageId: number;
  normalizedUrl: string;
  url?: string;
  depth: number;
  needs: PageCaptureTask['needs'];
  pageRunId?: number;
  purpose?: PageCaptureTask['purpose'];
  artifactRequirement?: ArtifactRequirement;
}): PageCaptureTask {
  return {
    stage: 'page_capture',
    runId: input.runId,
    siteId: input.siteId,
    sitePageId: input.sitePageId,
    normalizedUrl: input.normalizedUrl,
    url: input.url ?? input.normalizedUrl,
    depth: input.depth,
    needs: input.needs,
    pageRunId: input.pageRunId,
    purpose: input.purpose,
    artifactRequirement: input.artifactRequirement,
  };
}

async function logToolFallbackIfNeeded(input: {
  result: CaptureResult;
  task: PageCaptureTask;
  pageRunId: number;
  runLog: RunLogRepository;
  purpose: 'base' | 'artifact';
  artifactType?: ArtifactType;
}): Promise<void> {
  const summary = formatToolFallbackSummary(input.result.diagnostics);
  if (!summary) {
    return;
  }

  await input.runLog.tool_fallback({
    crawlRunId: input.task.runId,
    url: input.task.normalizedUrl,
    sitePageId: input.task.sitePageId,
    pageRunId: input.pageRunId,
    purpose: input.purpose,
    artifactType: input.artifactType ?? null,
    summary,
    meta: {
      diagnostics: input.result.diagnostics,
      needs: input.task.needs,
      purpose: input.task.purpose ?? null,
    },
  });
}

async function recordArtifactResult(input: {
  result: CaptureResult;
  artifactType: ArtifactType;
  task: PageCaptureTask;
  pageRunId: number;
  artifactRunRepository: ArtifactRunRepository;
  sitePageRepository: SitePageRepository;
  artifactWriter: FileArtifactWriter;
  runLog: RunLogRepository;
}): Promise<void> {
  const requirement =
    input.task.artifactRequirement ?? defaultArtifactRequirement(input.artifactType);
  if (input.artifactType === 'markdown') {
    if (!input.result.markdown) {
      throw new Error(`Markdown result missing for ${input.task.normalizedUrl}`);
    }

    const written = await input.artifactWriter.writeTextArtifact({
      artifactType: 'markdown',
      variantKey: requirement.variantKey,
      runId: input.task.runId,
      sitePageId: input.task.sitePageId,
      content: input.result.markdown.content,
      extension: 'md',
    });

    await input.artifactRunRepository.create({
      runId: input.task.runId,
      pageRunId: input.pageRunId,
      sitePageId: input.task.sitePageId,
      artifactType: 'markdown',
      variantKey: requirement.variantKey,
      configFingerprint: requirement.configFingerprint,
      status: 'succeeded',
      content: written.content,
      outputPath: written.outputPath,
      errorMessage: null,
      meta: { tool: input.result.markdown.toolName },
    });

    await input.runLog.log({
      crawlRunId: input.task.runId,
      level: 'info',
      event: 'artifact_done',
      url: input.task.normalizedUrl,
      sitePageId: input.task.sitePageId,
      pageRunId: input.pageRunId,
      message: `[markdown] done ${input.task.normalizedUrl}`,
      meta: {
        tool: input.result.markdown.toolName,
        outputPath: written.outputPath,
        artifactType: 'markdown',
        needs: input.task.needs,
        purpose: input.task.purpose ?? null,
        diagnostics: input.result.diagnostics,
        durationMs: input.result.durationMs ?? null,
      },
    });
    await logToolFallbackIfNeeded({
      result: input.result,
      task: input.task,
      pageRunId: input.pageRunId,
      runLog: input.runLog,
      purpose: 'artifact',
      artifactType: 'markdown',
    });
  } else if (input.artifactType === 'screenshot') {
    if (!input.result.screenshot) {
      throw new Error(`Screenshot result missing for ${input.task.normalizedUrl}`);
    }

    const written = await input.artifactWriter.writeBinaryArtifact({
      artifactType: 'screenshot',
      variantKey: requirement.variantKey,
      runId: input.task.runId,
      sitePageId: input.task.sitePageId,
      content: input.result.screenshot.data,
      extension: input.result.screenshot.extension,
    });

    await input.artifactRunRepository.create({
      runId: input.task.runId,
      pageRunId: input.pageRunId,
      sitePageId: input.task.sitePageId,
      artifactType: 'screenshot',
      variantKey: requirement.variantKey,
      configFingerprint: requirement.configFingerprint,
      status: 'succeeded',
      content: written.content,
      outputPath: written.outputPath,
      errorMessage: null,
      meta: {
        tool: input.result.screenshot.toolName,
        ...input.result.screenshot.metadata,
      },
    });

    await input.runLog.log({
      crawlRunId: input.task.runId,
      level: 'info',
      event: 'artifact_done',
      url: input.task.normalizedUrl,
      sitePageId: input.task.sitePageId,
      pageRunId: input.pageRunId,
      message: `[screenshot] done ${input.task.normalizedUrl}`,
      meta: {
        tool: input.result.screenshot.toolName,
        outputPath: written.outputPath,
        artifactType: 'screenshot',
        variantKey: requirement.variantKey,
        configFingerprint: requirement.configFingerprint,
        truncated: input.result.screenshot.metadata?.truncated ?? false,
        needs: input.task.needs,
        purpose: input.task.purpose ?? null,
        diagnostics: input.result.diagnostics,
        durationMs: input.result.durationMs ?? null,
      },
    });
    await logToolFallbackIfNeeded({
      result: input.result,
      task: input.task,
      pageRunId: input.pageRunId,
      runLog: input.runLog,
      purpose: 'artifact',
      artifactType: 'screenshot',
    });
  } else {
    if (input.result.structured === undefined) {
      throw new Error(`Structured result missing for ${input.task.normalizedUrl}`);
    }

    const content = `${JSON.stringify(input.result.structured, null, 2)}\n`;
    const written = await input.artifactWriter.writeTextArtifact({
      artifactType: 'structured',
      variantKey: requirement.variantKey,
      runId: input.task.runId,
      sitePageId: input.task.sitePageId,
      content,
      extension: 'json',
    });

    await input.artifactRunRepository.create({
      runId: input.task.runId,
      pageRunId: input.pageRunId,
      sitePageId: input.task.sitePageId,
      artifactType: 'structured',
      variantKey: requirement.variantKey,
      configFingerprint: requirement.configFingerprint,
      status: 'succeeded',
      content: written.content,
      outputPath: written.outputPath,
      errorMessage: null,
      meta: { outputPath: written.outputPath },
    });

    await input.runLog.log({
      crawlRunId: input.task.runId,
      level: 'info',
      event: 'artifact_done',
      url: input.task.normalizedUrl,
      sitePageId: input.task.sitePageId,
      pageRunId: input.pageRunId,
      message: `[structured] done ${input.task.normalizedUrl}`,
      meta: {
        outputPath: written.outputPath,
        artifactType: 'structured',
        needs: input.task.needs,
        purpose: input.task.purpose ?? null,
        diagnostics: input.result.diagnostics,
        durationMs: input.result.durationMs ?? null,
      },
    });
    await logToolFallbackIfNeeded({
      result: input.result,
      task: input.task,
      pageRunId: input.pageRunId,
      runLog: input.runLog,
      purpose: 'artifact',
      artifactType: 'structured',
    });
  }

  await input.sitePageRepository.recordArtifactResult({
    sitePageId: input.task.sitePageId,
    runId: input.task.runId,
    artifactType: input.artifactType,
    status: 'succeeded',
    pageRunId: input.pageRunId,
  });
}

async function recordArtifactFailure(input: {
  task: PageCaptureTask;
  artifactType: ArtifactType;
  pageRunId: number;
  error: Error;
  artifactRunRepository: ArtifactRunRepository;
  sitePageRepository: SitePageRepository;
  runLog: RunLogRepository;
}): Promise<void> {
  const requirement =
    input.task.artifactRequirement ?? defaultArtifactRequirement(input.artifactType);
  await input.artifactRunRepository.create({
    runId: input.task.runId,
    pageRunId: input.pageRunId,
    sitePageId: input.task.sitePageId,
    artifactType: input.artifactType,
    variantKey: requirement.variantKey,
    configFingerprint: requirement.configFingerprint,
    status: 'failed' satisfies ArtifactRunStatus,
    content: null,
    outputPath: null,
    errorMessage: input.error.message,
    meta: null,
  });

  await input.runLog.log({
    crawlRunId: input.task.runId,
    level: 'error',
    event: 'artifact_failed',
    url: input.task.normalizedUrl,
    sitePageId: input.task.sitePageId,
    pageRunId: input.pageRunId,
    message: `[${input.artifactType}] FAILED ${input.task.normalizedUrl}: ${input.error.message}`,
    meta: {
      artifactType: input.artifactType,
      variantKey: requirement.variantKey,
      configFingerprint: requirement.configFingerprint,
      needs: input.task.needs,
      purpose: input.task.purpose ?? null,
      stack: input.error.stack ?? null,
    },
  });

  await input.sitePageRepository.recordArtifactResult({
    sitePageId: input.task.sitePageId,
    runId: input.task.runId,
    artifactType: input.artifactType,
    status: 'failed',
    pageRunId: input.pageRunId,
  });
}

interface PageCaptureHandlerDeps {
  executor: PageCaptureExecutor;
  classifier: Classifier;
  siteConfig: SiteConfig;
  runType: RunType;
  updatePolicy: UpdatePolicy;
  staleAfterMs: number | null;
  pageCaptureQueue: RequestQueue;
  artifactWriter: FileArtifactWriter;
  artifactRunRepository: ArtifactRunRepository;
  pageRunRepository: PageRunRepository;
  sitePageRepository: SitePageRepository;
  runPlanner: RunPlanner;
  runLog: RunLogRepository;
  captureTools: CaptureTool[];
  targetTracker?: RunTargetTracker;
}

type PageCaptureHandlerInput = PageCaptureHandlerDeps & {
  task: PageCaptureTask;
  runtime: RuntimeContext;
};

export function createPageCaptureRequestHandler(deps: PageCaptureHandlerDeps) {
  return async (input: { task: PageCaptureTask; runtime: RuntimeContext }) => {
    const { task } = input;

    if (task.needs.includes('base')) {
      await handleBaseTask({ ...deps, task, runtime: input.runtime });
      return;
    }

    await handleArtifactOnlyTask({ ...deps, task, runtime: input.runtime });
  };
}

async function handleBaseTask(input: PageCaptureHandlerInput): Promise<void> {
  const deps = input;
  const task = input.task;

  if (deps.targetTracker?.isReached()) {
    await deps.runLog.log({
      crawlRunId: task.runId,
      level: 'info',
      event: 'base_page_skipped_target_reached',
      url: task.normalizedUrl,
      sitePageId: task.sitePageId,
      message: `[base] SKIPPED target reached ${task.normalizedUrl}`,
      meta: {
        candidateSuccessCount: deps.targetTracker.getCandidateSuccessCount(),
      },
    });
    return;
  }

  const result = await deps.executor.capture({
    runId: task.runId,
    siteId: task.siteId,
    url: task.url,
    normalizedUrl: task.normalizedUrl,
    needs: task.needs,
    siteConfig: deps.siteConfig,
    runtime: deps.runtime,
    artifactRequirement: task.artifactRequirement,
  });

  if (!result.extracted) {
    throw new Error(`Base result missing for ${task.normalizedUrl}`);
  }

  const extracted = result.extracted;
  const historyBeforeCapture = await deps.sitePageRepository.getHistoricalState(
    task.siteId,
    extracted.normalizedUrl,
  );
  let classificationError: Error | null = null;
  let classification = null;

  try {
    classification = await deps.classifier.classify(extracted);
  } catch (error) {
    classificationError = error instanceof Error ? error : new Error(String(error));
    logger.error('Base page classification failed', {
      runId: task.runId,
      siteId: task.siteId,
      sitePageId: task.sitePageId,
      requestUrl: task.url,
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
  const requirements = expandArtifactRequirements(
    decision.requiredArtifacts,
    deps.siteConfig,
  );
  const baseCapture = await deps.artifactWriter.writeBaseCapture({
    runId: task.runId,
    sitePageId: task.sitePageId,
    content: renderBaseCaptureMarkdown({
      url: extracted.normalizedUrl,
      title: extracted.title,
      metaDescription: extracted.metaDescription,
      bodyText: extracted.bodyText,
    }),
  });

  const pageRunId = await deps.pageRunRepository.create({
    runId: task.runId,
    sitePageId: task.sitePageId,
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
    requiredArtifacts: requirements,
  });

  await deps.runLog.base_page_done({
    crawlRunId: task.runId,
    url: extracted.normalizedUrl,
    sitePageId: task.sitePageId,
    pageRunId,
    outcome: decision.pageOutcome,
    meta: {
      outcome: decision.pageOutcome,
      reason: decision.reason ?? null,
      requiredArtifacts: decision.requiredArtifacts,
      title: extracted.title || null,
      needs: task.needs,
      purpose: task.purpose ?? null,
      requestId: deps.runtime.requestId,
      diagnostics: result.diagnostics,
    },
  });

  await logToolFallbackIfNeeded({
    result,
    task,
    pageRunId,
    runLog: deps.runLog,
    purpose: 'base',
  });

  await deps.sitePageRepository.recordBaseCapture({
    sitePageId: task.sitePageId,
    runId: task.runId,
    title: extracted.title,
    pageOutcome: decision.pageOutcome,
    requiredArtifacts: requirements,
    pendingReason: decision.pendingReason,
  });

  const isTargetSuccessCandidate =
    decision.pageOutcome === 'allow' ||
    (deps.runType === 'seed_run' && decision.pendingReason === 'seed_run');

  if (isTargetSuccessCandidate) {
    const targetState = deps.targetTracker?.recordCandidateSuccess();

    if (targetState?.reachedNow && targetState.target !== null) {
      await deps.runLog.target_success_count_reached({
        crawlRunId: task.runId,
        url: extracted.normalizedUrl,
        sitePageId: task.sitePageId,
        pageRunId,
        targetSuccessCount: targetState.target,
        candidateSuccessCount: targetState.count,
      });
    }
  }

  if (deps.runType === 'crawl_run' && decision.pageOutcome === 'allow') {
    const capturedArtifacts = new Set<ArtifactType>();

    for (const artifactType of decision.requiredArtifacts) {
      const alreadyCaptured =
        artifactType === 'markdown'
          ? result.markdown !== undefined
          : artifactType === 'screenshot'
            ? result.screenshot !== undefined
            : result.structured !== undefined;

      if (!alreadyCaptured) {
        continue;
      }

      if (!shouldEnqueueArtifactByUpdatePolicy({
        policy: deps.updatePolicy,
        history: historyBeforeCapture,
        artifactType,
        nowIsoString: new Date().toISOString(),
        staleAfterMs: deps.staleAfterMs,
      })) {
        continue;
      }

      await recordArtifactResult({
        result,
        artifactType,
        task,
        pageRunId,
        artifactRunRepository: deps.artifactRunRepository,
        sitePageRepository: deps.sitePageRepository,
        artifactWriter: deps.artifactWriter,
        runLog: deps.runLog,
      });
      capturedArtifacts.add(artifactType);
    }

    const remainingRequirements: ArtifactRequirement[] = [];
    for (const requirement of requirements) {
      if (
        requirement.variantKey === 'default' &&
        capturedArtifacts.has(requirement.artifactType)
      ) {
        continue;
      }
      if (
        requirement.artifactType !== 'screenshot' ||
        deps.siteConfig.screenshot?.mode !== 'complete'
      ) {
        if (shouldEnqueueArtifactByUpdatePolicy({
          policy: deps.updatePolicy,
          history: historyBeforeCapture,
          artifactType: requirement.artifactType,
          nowIsoString: new Date().toISOString(),
          staleAfterMs: deps.staleAfterMs,
        })) {
          remainingRequirements.push(requirement);
        }
        continue;
      }
      const latest = await deps.artifactRunRepository.latestStatus({
        sitePageId: task.sitePageId,
        requirement,
      });
      const stale = latest
        ? Date.now() - new Date(latest.finishedAt).getTime() >= (deps.staleAfterMs ?? 0)
        : false;
      if (
        deps.updatePolicy === 'force_recrawl_all' ||
        latest?.status !== 'succeeded' ||
        (deps.updatePolicy === 'stale_after_duration' && stale)
      ) {
        remainingRequirements.push(requirement);
      }
    }

    for (const requirement of remainingRequirements) {
      await deps.pageCaptureQueue.addRequest({
        url: extracted.normalizedUrl,
        uniqueKey: requirement.configFingerprint === null
          ? `artifact:${task.runId}:${task.sitePageId}:${requirement.artifactType}`
          : `artifact:${task.runId}:${task.sitePageId}:${requirement.artifactType}:${requirement.variantKey}:${requirement.configFingerprint}`,
        userData: buildTask({
          runId: task.runId,
          siteId: task.siteId,
          sitePageId: task.sitePageId,
          normalizedUrl: extracted.normalizedUrl,
          depth: task.depth,
          needs: [requirement.artifactType],
          pageRunId,
          purpose: 'artifact',
          artifactRequirement: requirement,
        }),
      });
    }
    if (remainingRequirements.length === 0 && capturedArtifacts.size === 0) {
      await deps.sitePageRepository.refreshArtifactStatus({
        sitePageId: task.sitePageId,
        runId: task.runId,
        pageRunId,
      });
    }
  }

  if (deps.targetTracker?.isReached()) {
    return;
  }

  if (task.depth >= getMaxDepth(deps.runType, deps.siteConfig)) {
    return;
  }

  for (const link of extracted.links) {
    const plannedRequest = await deps.runPlanner.planRequest({
      siteId: task.siteId,
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
        runId: task.runId,
        siteId: task.siteId,
        discoveredUrl: link,
        referrerUrl: extracted.normalizedUrl,
        errorMessage: error.message,
      });
      await deps.runLog.url_plan_skipped(
        task.runId,
        link,
        {
          reason: 'invalid_url',
          discoverySource: 'page_link',
          discoveryReferrerUrl: extracted.normalizedUrl,
          errorMessage: error.message,
        },
        { sitePageId: task.sitePageId, pageRunId },
      );
      return null;
    });

    if (plannedRequest === null || !plannedRequest.enqueue) {
      continue;
    }

    const history = await deps.sitePageRepository.getHistoricalState(
      task.siteId,
      plannedRequest.normalizedUrl,
    );
    const captureNeeds = resolveBaseTaskNeeds({
      url: plannedRequest.normalizedUrl,
      siteConfig: deps.siteConfig,
      runType: deps.runType,
      updatePolicy: deps.updatePolicy,
      history,
      staleAfterMs: deps.staleAfterMs,
      nowIsoString: new Date().toISOString(),
      captureTools: deps.captureTools,
    });

    await deps.pageCaptureQueue.addRequest({
      url: link,
      uniqueKey: `base:${task.runId}:${plannedRequest.sitePageId}`,
      userData: buildTask({
        runId: task.runId,
        siteId: task.siteId,
        sitePageId: plannedRequest.sitePageId,
        normalizedUrl: plannedRequest.normalizedUrl,
        url: link,
        depth: task.depth + 1,
        needs: captureNeeds,
        purpose: 'discovery',
      }),
    });
  }
}

async function handleArtifactOnlyTask(input: PageCaptureHandlerInput): Promise<void> {
  const deps = input;
  const task = input.task;
  const pageRunId = task.pageRunId;

  if (pageRunId === undefined) {
    throw new Error(`Artifact-only task requires pageRunId for ${task.normalizedUrl}`);
  }

  const artifacts = artifactNeeds(task.needs);
  const result = await deps.executor.capture({
    runId: task.runId,
    siteId: task.siteId,
    url: task.url,
    normalizedUrl: task.normalizedUrl,
    needs: artifacts,
    siteConfig: deps.siteConfig,
    runtime: deps.runtime,
    artifactRequirement: task.artifactRequirement,
  });

  for (const artifactType of artifacts) {
    if (captureResultHasArtifact(result, artifactType)) {
      await recordArtifactResult({
        result,
        artifactType,
        task,
        pageRunId,
        artifactRunRepository: deps.artifactRunRepository,
        sitePageRepository: deps.sitePageRepository,
        artifactWriter: deps.artifactWriter,
        runLog: deps.runLog,
      });
      continue;
    }

    await recordArtifactFailure({
      task,
      artifactType,
      pageRunId,
      error: new Error(`${artifactType} result missing for ${task.normalizedUrl}`),
      artifactRunRepository: deps.artifactRunRepository,
      sitePageRepository: deps.sitePageRepository,
      runLog: deps.runLog,
    });
  }
}

export function createPageCaptureFailedRequestHandler(deps: {
  artifactRunRepository: ArtifactRunRepository;
  pageRunRepository: PageRunRepository;
  sitePageRepository: SitePageRepository;
  runLog: RunLogRepository;
}) {
  return async (input: { task: PageCaptureTask; request: { url: string }; error: Error }) => {
    const { task, error } = input;

    if (task.needs.includes('base')) {
      await deps.pageRunRepository.createFailed({
        runId: task.runId,
        sitePageId: task.sitePageId,
        errorMessage: error.message,
      });

      await deps.sitePageRepository.recordBaseCaptureFailed({
        runId: task.runId,
        sitePageId: task.sitePageId,
      });

      await deps.runLog.log({
        crawlRunId: task.runId,
        level: 'error',
        event: 'base_page_failed',
        url: input.request.url,
        sitePageId: task.sitePageId,
        message: `[base] FAILED ${input.request.url}: ${error.message}`,
        meta: {
          needs: task.needs,
          purpose: task.purpose ?? null,
          stack: error.stack ?? null,
        },
      });
      return;
    }

    if (task.pageRunId === undefined) {
      throw error;
    }

    for (const artifactType of artifactNeeds(task.needs)) {
      await recordArtifactFailure({
        task,
        artifactType,
        pageRunId: task.pageRunId,
        error,
        artifactRunRepository: deps.artifactRunRepository,
        sitePageRepository: deps.sitePageRepository,
        runLog: deps.runLog,
      });
    }
  };
}
