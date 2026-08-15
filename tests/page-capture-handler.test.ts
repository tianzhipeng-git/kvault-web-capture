import { describe, expect, it } from 'vitest';

import type { CaptureTool } from '../src/capture/types.js';
import { PageCaptureExecutor } from '../src/capture/executor.js';
import type { CaptureResult, RuntimeContext } from '../src/capture/types.js';
import { FakeClassifier } from '../src/classification/fake-classifier.js';
import { createDefaultSiteConfig } from '../src/config/site-config.js';
import type {
  ArtifactRunRepository,
  PageRunRepository,
  RunLogRepository,
  SitePageRepository,
} from '../src/db/repositories/index.js';
import type { ExtractedPage, PageCaptureTask } from '../src/domain/types.js';
import type { FileArtifactWriter } from '../src/export/file-artifact-writer.js';
import type { RunPlanner } from '../src/planner/run-planner.js';
import type { RequestQueue } from 'crawlee';
import {
  createPageCaptureFailedRequestHandler,
  createPageCaptureRequestHandler,
} from '../src/crawlee/handlers.js';

// ────────────────────────────────── test doubles ──────────────────────────────

const noopRunLog: RunLogRepository = {
  log: () => Promise.resolve(),
  base_page_done: () => Promise.resolve(),
  target_success_count_reached: () => Promise.resolve(),
  url_plan_skipped: () => Promise.resolve(),
  listByRun: () => Promise.resolve([]),
} as unknown as RunLogRepository;

const runtime: RuntimeContext = {
  requestId: 'test-request',
  sendRequest: async () => { throw new Error('not used'); },
};

const siteConfig = createDefaultSiteConfig('https://example.com');
const defaultTestCaptureTools: CaptureTool[] = [];

function makeExtractedPage(overrides?: Partial<ExtractedPage>): ExtractedPage {
  return {
    url: 'https://example.com/docs',
    normalizedUrl: 'https://example.com/docs',
    title: 'Docs page',
    metaDescription: 'Example docs',
    bodyText: 'body text',
    links: [],
    ...overrides,
  };
}

function makeBaseTask(overrides?: Partial<PageCaptureTask>): PageCaptureTask {
  return {
    stage: 'page_capture',
    runId: 1,
    siteId: 10,
    sitePageId: 100,
    normalizedUrl: 'https://example.com/docs',
    url: 'https://example.com/docs',
    depth: 0,
    needs: ['base'],
    purpose: 'discovery',
    ...overrides,
  };
}

function makeArtifactTask(overrides?: Partial<PageCaptureTask>): PageCaptureTask {
  return {
    stage: 'page_capture',
    runId: 1,
    siteId: 10,
    sitePageId: 100,
    normalizedUrl: 'https://example.com/docs',
    url: 'https://example.com/docs',
    depth: 0,
    needs: ['markdown'],
    pageRunId: 999,
    purpose: 'artifact',
    ...overrides,
  };
}

function makeSuccessBaseCaptureResult(): CaptureResult {
  return {
    url: 'https://example.com/docs',
    finalUrl: 'https://example.com/docs',
    statusCode: 200,
    html: '<html><head><title>Docs page</title></head><body>body text</body></html>',
    extracted: makeExtractedPage(),
    diagnostics: [],
  };
}

function makeMarkdownCaptureResult(): CaptureResult {
  return {
    url: 'https://example.com/docs',
    markdown: { content: '# Docs\n', toolName: 'defuddle' },
    diagnostics: [],
  };
}

function makeStructuredCaptureResult(): CaptureResult {
  return {
    url: 'https://example.com/docs',
    structured: { title: 'Docs page', items: [{ id: 1, text: 'hello' }] },
    diagnostics: [],
  };
}

function makeNoopPlanner(): RunPlanner {
  return {
    planRequest: async () => ({ siteId: 10, sitePageId: 101, normalizedUrl: 'https://example.com/other', enqueue: false, urlRuleDecision: 'allow', planReason: null }),
  } as unknown as RunPlanner;
}

function makeNoopRequestQueue(): { queue: RequestQueue; calls: unknown[] } {
  const calls: unknown[] = [];
  const queue = {
    addRequest: async (req: unknown) => { calls.push(req); return { wasAlreadyPresent: false }; },
  } as unknown as RequestQueue;
  return { queue, calls };
}

function makeSitePageRepository(overrides?: Partial<SitePageRepository>): SitePageRepository {
  return {
    getHistoricalState: async () => null,
    recordBaseCapture: async () => {},
    recordArtifactResult: async () => {},
    recordBaseCaptureFailed: async () => {},
    upsertDiscovery: async () => 0,
    markUrlRuleDenied: async () => {},
    ...overrides,
  } as unknown as SitePageRepository;
}

function makePageRunRepository(overrides?: Partial<PageRunRepository>): PageRunRepository {
  return {
    create: async () => 999,
    createFailed: async () => {},
    ...overrides,
  } as unknown as PageRunRepository;
}

function makeArtifactRunRepository(overrides?: Partial<ArtifactRunRepository>): ArtifactRunRepository {
  return {
    create: async () => 1,
    ...overrides,
  } as unknown as ArtifactRunRepository;
}

function makeArtifactWriter(): { writer: FileArtifactWriter; baseCalls: unknown[]; textCalls: unknown[]; binaryCalls: unknown[] } {
  const baseCalls: unknown[] = [];
  const textCalls: unknown[] = [];
  const binaryCalls: unknown[] = [];
  const writer = {
    writeBaseCapture: async (args: unknown) => {
      baseCalls.push(args);
      return { outputPath: '/tmp/base.md', content: '# Base capture\n' };
    },
    writeTextArtifact: async (args: { content: string }) => {
      textCalls.push(args);
      return { outputPath: '/tmp/markdown.md', content: args.content };
    },
    writeBinaryArtifact: async (args: unknown) => {
      binaryCalls.push(args);
      return { outputPath: '/tmp/screenshot.png', content: Buffer.from('fake') };
    },
  } as unknown as FileArtifactWriter;
  return { writer, baseCalls, textCalls, binaryCalls };
}

// ─────────────────────────────── base task tests ──────────────────────────────

describe('createPageCaptureRequestHandler – base task', () => {
  it('calls executor, writes page_run, and records run log on success', async () => {
    const executorCaptureCalls: unknown[] = [];
    const executor = {
      capture: async (input: unknown) => {
        executorCaptureCalls.push(input);
        return makeSuccessBaseCaptureResult();
      },
    } as unknown as PageCaptureExecutor;

    const pageRunCalls: unknown[] = [];
    const pageRunRepository = makePageRunRepository({
      create: async (args: unknown) => { pageRunCalls.push(args); return 999; },
    });

    const sitePageCalls: unknown[] = [];
    const sitePageRepository = makeSitePageRepository({
      recordBaseCapture: async (args: unknown) => { sitePageCalls.push(args); },
    });

    const { writer, baseCalls } = makeArtifactWriter();
    const { queue } = makeNoopRequestQueue();
    const logCalls: unknown[] = [];
    const runLog: RunLogRepository = {
      log: async (args: unknown) => { logCalls.push(args); },
      base_page_done: async () => {
        logCalls.push({ event: 'base_page_done' });
      },
    } as unknown as RunLogRepository;

    const handler = createPageCaptureRequestHandler({
      executor,
      classifier: new FakeClassifier(),
      siteConfig,
      runType: 'seed_run',
      updatePolicy: 'force_recrawl_all',
      staleAfterMs: null,
      pageCaptureQueue: queue,
      artifactWriter: writer,
      artifactRunRepository: makeArtifactRunRepository(),
      pageRunRepository,
      sitePageRepository,
      runPlanner: makeNoopPlanner(),
      captureTools: defaultTestCaptureTools,
      runLog,
    });

    await handler({ task: makeBaseTask(), runtime });

    expect(executorCaptureCalls).toHaveLength(1);
    expect(baseCalls).toHaveLength(1);
    expect(pageRunCalls).toHaveLength(1);
    expect(sitePageCalls).toHaveLength(1);

    const logEvents = (logCalls as Array<{ event: string }>).map((c) => c.event);
    expect(logEvents).toContain('base_page_done');
  });

  it('enqueues separate artifact tasks per type for crawl_run allow', async () => {
    const executor = {
      capture: async () => makeSuccessBaseCaptureResult(),
    } as unknown as PageCaptureExecutor;

    const { queue, calls: enqueueCalls } = makeNoopRequestQueue();
    const { writer } = makeArtifactWriter();

    const handler = createPageCaptureRequestHandler({
      executor,
      classifier: new FakeClassifier(),
      siteConfig,
      runType: 'crawl_run',
      updatePolicy: 'force_recrawl_all',
      staleAfterMs: null,
      pageCaptureQueue: queue,
      artifactWriter: writer,
      artifactRunRepository: makeArtifactRunRepository(),
      pageRunRepository: makePageRunRepository(),
      sitePageRepository: makeSitePageRepository(),
      runPlanner: makeNoopPlanner(),
      captureTools: defaultTestCaptureTools,
      runLog: noopRunLog,
    });

    const task = makeBaseTask({ needs: ['base'] });
    await handler({ task, runtime });

    const artifactRequests = (enqueueCalls as Array<{ userData: PageCaptureTask }>).filter(
      (r) => r.userData?.purpose === 'artifact',
    );

    expect(artifactRequests.length).toBeGreaterThan(0);
    for (const req of artifactRequests) {
      expect(req.userData.needs).toHaveLength(1);
    }
  });

  it('expands complete screenshots into independent variant tasks', async () => {
    const completeConfig = createDefaultSiteConfig('https://example.com');
    completeConfig.rulesBeforeStage2Eq[0] = {
      ...completeConfig.rulesBeforeStage2Eq[0],
      artifacts: ['screenshot'],
    };
    completeConfig.screenshot = {
      mode: 'complete',
      preparation: {
        dismissSelectors: [],
        waitForImages: true,
        waitForFonts: true,
        scrollDocument: true,
        scrollContainers: true,
        expandScrollContainers: true,
        scrollStepRatio: 0.8,
        settleMs: 500,
        stableRounds: 2,
        maxScrollRounds: 100,
        maxCaptureHeight: 50_000,
        timeoutMs: 90_000,
        onLimit: 'truncate',
      },
      variants: [
        {
          key: 'desktop',
          device: 'desktop',
          viewport: { width: 1440, height: 900 },
          deviceScaleFactor: 1,
        },
        { key: 'mobile', device: 'iPhone 15' },
      ],
    };
    const { queue, calls } = makeNoopRequestQueue();
    const pageRunCalls: Array<{ requiredArtifacts: unknown[] }> = [];
    const artifactRuns = makeArtifactRunRepository({
      latestStatus: async () => null,
    });
    const handler = createPageCaptureRequestHandler({
      executor: {
        capture: async () => makeSuccessBaseCaptureResult(),
      } as unknown as PageCaptureExecutor,
      classifier: new FakeClassifier(),
      siteConfig: completeConfig,
      runType: 'crawl_run',
      updatePolicy: 'force_recrawl_all',
      staleAfterMs: null,
      pageCaptureQueue: queue,
      artifactWriter: makeArtifactWriter().writer,
      artifactRunRepository: artifactRuns,
      pageRunRepository: makePageRunRepository({
        create: async (input: unknown) => {
          pageRunCalls.push(input as { requiredArtifacts: unknown[] });
          return 999;
        },
      }),
      sitePageRepository: makeSitePageRepository(),
      runPlanner: makeNoopPlanner(),
      captureTools: defaultTestCaptureTools,
      runLog: noopRunLog,
    });

    await handler({ task: makeBaseTask(), runtime });

    const artifactTasks = (calls as Array<{
      uniqueKey: string;
      userData: PageCaptureTask;
    }>).filter((request) => request.userData.purpose === 'artifact');
    expect(artifactTasks).toHaveLength(2);
    expect(artifactTasks.map((request) => request.userData.artifactRequirement?.variantKey))
      .toEqual(['desktop', 'mobile']);
    expect(new Set(artifactTasks.map((request) => request.uniqueKey)).size).toBe(2);
    expect(pageRunCalls[0].requiredArtifacts).toHaveLength(2);
  });

  it('persists eager artifacts from a combined base task without enqueueing artifact tasks', async () => {
    const executorCaptureCalls: unknown[] = [];
    const executor = {
      capture: async (input: unknown) => {
        executorCaptureCalls.push(input);
        return {
          ...makeSuccessBaseCaptureResult(),
          markdown: { content: '# Docs\n', toolName: 'full-capture' },
        };
      },
    } as unknown as PageCaptureExecutor;

    const { queue, calls: enqueueCalls } = makeNoopRequestQueue();
    const { writer } = makeArtifactWriter();
    const artifactRunRepository = makeArtifactRunRepository();
    const artifactCreateCalls: unknown[] = [];
    artifactRunRepository.create = async (input: unknown) => {
      artifactCreateCalls.push(input);
      return 501;
    };

    const handler = createPageCaptureRequestHandler({
      executor,
      classifier: new FakeClassifier(),
      siteConfig,
      runType: 'crawl_run',
      updatePolicy: 'force_recrawl_all',
      staleAfterMs: null,
      pageCaptureQueue: queue,
      artifactWriter: writer,
      artifactRunRepository,
      pageRunRepository: makePageRunRepository(),
      sitePageRepository: makeSitePageRepository(),
      runPlanner: makeNoopPlanner(),
      captureTools: defaultTestCaptureTools,
      runLog: noopRunLog,
    });

    await handler({
      task: makeBaseTask({ needs: ['base', 'markdown'] }),
      runtime,
    });

    expect(executorCaptureCalls).toHaveLength(1);
    expect((executorCaptureCalls[0] as { needs: string[] }).needs).toEqual(['base', 'markdown']);
    expect(enqueueCalls).toHaveLength(0);
    expect(artifactCreateCalls).toHaveLength(1);
    expect((artifactCreateCalls[0] as { artifactType: string }).artifactType).toBe('markdown');
  });

  it('skips enqueuing artifact tasks for seed_run', async () => {
    const executor = {
      capture: async () => makeSuccessBaseCaptureResult(),
    } as unknown as PageCaptureExecutor;

    const { queue, calls: enqueueCalls } = makeNoopRequestQueue();
    const { writer } = makeArtifactWriter();

    const handler = createPageCaptureRequestHandler({
      executor,
      classifier: new FakeClassifier(),
      siteConfig,
      runType: 'seed_run',
      updatePolicy: 'force_recrawl_all',
      staleAfterMs: null,
      pageCaptureQueue: queue,
      artifactWriter: writer,
      artifactRunRepository: makeArtifactRunRepository(),
      pageRunRepository: makePageRunRepository(),
      sitePageRepository: makeSitePageRepository(),
      runPlanner: makeNoopPlanner(),
      captureTools: defaultTestCaptureTools,
      runLog: noopRunLog,
    });

    await handler({ task: makeBaseTask({ needs: ['base'] }), runtime });

    const artifactRequests = (enqueueCalls as Array<{ userData: PageCaptureTask }>).filter(
      (r) => r.userData?.purpose === 'artifact',
    );
    expect(artifactRequests).toHaveLength(0);
  });

  it('skips processing when target tracker is reached', async () => {
    const executorCaptureCalls: unknown[] = [];
    const executor = {
      capture: async (input: unknown) => { executorCaptureCalls.push(input); return makeSuccessBaseCaptureResult(); },
    } as unknown as PageCaptureExecutor;

    const logCalls: unknown[] = [];
    const runLog: RunLogRepository = {
      log: async (args: unknown) => { logCalls.push(args); },
    } as unknown as RunLogRepository;

    const handler = createPageCaptureRequestHandler({
      executor,
      classifier: new FakeClassifier(),
      siteConfig,
      runType: 'crawl_run',
      updatePolicy: 'force_recrawl_all',
      staleAfterMs: null,
      pageCaptureQueue: makeNoopRequestQueue().queue,
      artifactWriter: makeArtifactWriter().writer,
      artifactRunRepository: makeArtifactRunRepository(),
      pageRunRepository: makePageRunRepository(),
      sitePageRepository: makeSitePageRepository(),
      runPlanner: makeNoopPlanner(),
      captureTools: defaultTestCaptureTools,
      runLog,
      targetTracker: {
        isReached: () => true,
        getCandidateSuccessCount: () => 5,
        recordCandidateSuccess: () => ({ reachedNow: false, target: 5, count: 5 }),
      } as unknown as import('../src/planner/run-target-tracker.js').RunTargetTracker,
    });

    await handler({ task: makeBaseTask(), runtime });

    expect(executorCaptureCalls).toHaveLength(0);
    const skippedLogs = (logCalls as Array<{ event: string }>).filter(
      (c) => c.event === 'base_page_skipped_target_reached',
    );
    expect(skippedLogs).toHaveLength(1);
  });
});

// ─────────────────────────── artifact-only task tests ─────────────────────────

describe('createPageCaptureRequestHandler – artifact-only task', () => {
  it('calls executor with artifact needs and records artifact_run on success', async () => {
    const executorCaptureCalls: unknown[] = [];
    const executor = {
      capture: async (input: unknown) => {
        executorCaptureCalls.push(input);
        return makeMarkdownCaptureResult();
      },
    } as unknown as PageCaptureExecutor;

    const artifactRunCalls: unknown[] = [];
    const artifactRunRepository = makeArtifactRunRepository({
      create: async (args: unknown) => { artifactRunCalls.push(args); return 1; },
    });

    const sitePageCalls: unknown[] = [];
    const sitePageRepository = makeSitePageRepository({
      recordArtifactResult: async (args: unknown) => { sitePageCalls.push(args); },
    });

    const { writer, textCalls } = makeArtifactWriter();

    const handler = createPageCaptureRequestHandler({
      executor,
      classifier: new FakeClassifier(),
      siteConfig,
      runType: 'crawl_run',
      updatePolicy: 'force_recrawl_all',
      staleAfterMs: null,
      pageCaptureQueue: makeNoopRequestQueue().queue,
      artifactWriter: writer,
      artifactRunRepository,
      pageRunRepository: makePageRunRepository(),
      sitePageRepository,
      runPlanner: makeNoopPlanner(),
      captureTools: defaultTestCaptureTools,
      runLog: noopRunLog,
    });

    await handler({ task: makeArtifactTask(), runtime });

    expect(executorCaptureCalls).toHaveLength(1);
    expect((executorCaptureCalls[0] as { needs: string[] }).needs).toEqual(['markdown']);
    expect(textCalls).toHaveLength(1);
    expect(artifactRunCalls).toHaveLength(1);
    expect((artifactRunCalls[0] as { status: string }).status).toBe('succeeded');
    expect(sitePageCalls).toHaveLength(1);
    expect((sitePageCalls[0] as { status: string }).status).toBe('succeeded');
  });

  it('writes structured artifact-only task as JSON', async () => {
    const executorCaptureCalls: unknown[] = [];
    const executor = {
      capture: async (input: unknown) => {
        executorCaptureCalls.push(input);
        return makeStructuredCaptureResult();
      },
    } as unknown as PageCaptureExecutor;

    const artifactRunCalls: unknown[] = [];
    const artifactRunRepository = makeArtifactRunRepository({
      create: async (args: unknown) => { artifactRunCalls.push(args); return 1; },
    });

    const sitePageCalls: unknown[] = [];
    const sitePageRepository = makeSitePageRepository({
      recordArtifactResult: async (args: unknown) => { sitePageCalls.push(args); },
    });

    const { writer, textCalls } = makeArtifactWriter();
    const handler = createPageCaptureRequestHandler({
      executor,
      classifier: new FakeClassifier(),
      siteConfig,
      runType: 'crawl_run',
      updatePolicy: 'force_recrawl_all',
      staleAfterMs: null,
      pageCaptureQueue: makeNoopRequestQueue().queue,
      artifactWriter: writer,
      artifactRunRepository,
      pageRunRepository: makePageRunRepository(),
      sitePageRepository,
      runPlanner: makeNoopPlanner(),
      captureTools: defaultTestCaptureTools,
      runLog: noopRunLog,
    });

    await handler({
      task: makeArtifactTask({ needs: ['structured'], pageRunId: 999 }),
      runtime,
    });

    expect(executorCaptureCalls).toHaveLength(1);
    expect((executorCaptureCalls[0] as { needs: string[] }).needs).toEqual(['structured']);
    expect(textCalls).toHaveLength(1);
    expect((textCalls[0] as { artifactType: string; extension: string; content: string }).artifactType).toBe('structured');
    expect((textCalls[0] as { extension: string }).extension).toBe('json');
    expect(JSON.parse((textCalls[0] as { content: string }).content)).toEqual({
      title: 'Docs page',
      items: [{ id: 1, text: 'hello' }],
    });
    expect((artifactRunCalls[0] as { artifactType: string; status: string }).artifactType).toBe('structured');
    expect((artifactRunCalls[0] as { status: string }).status).toBe('succeeded');
    expect((sitePageCalls[0] as { artifactType: string; status: string }).artifactType).toBe('structured');
  });

  it('records successful and missing artifacts independently in one artifact-only task', async () => {
    const executor = {
      capture: async () => makeMarkdownCaptureResult(),
    } as unknown as PageCaptureExecutor;

    const artifactRunCalls: unknown[] = [];
    const artifactRunRepository = makeArtifactRunRepository({
      create: async (args: unknown) => { artifactRunCalls.push(args); return 1; },
    });

    const sitePageCalls: unknown[] = [];
    const sitePageRepository = makeSitePageRepository({
      recordArtifactResult: async (args: unknown) => { sitePageCalls.push(args); },
    });

    const { writer, textCalls, binaryCalls } = makeArtifactWriter();
    const handler = createPageCaptureRequestHandler({
      executor,
      classifier: new FakeClassifier(),
      siteConfig,
      runType: 'crawl_run',
      updatePolicy: 'force_recrawl_all',
      staleAfterMs: null,
      pageCaptureQueue: makeNoopRequestQueue().queue,
      artifactWriter: writer,
      artifactRunRepository,
      pageRunRepository: makePageRunRepository(),
      sitePageRepository,
      runPlanner: makeNoopPlanner(),
      captureTools: defaultTestCaptureTools,
      runLog: noopRunLog,
    });

    await handler({
      task: makeArtifactTask({ needs: ['markdown', 'screenshot'], pageRunId: 999 }),
      runtime,
    });

    expect(textCalls).toHaveLength(1);
    expect(binaryCalls).toHaveLength(0);
    expect(artifactRunCalls).toHaveLength(2);
    expect(artifactRunCalls).toEqual([
      expect.objectContaining({ artifactType: 'markdown', status: 'succeeded' }),
      expect.objectContaining({
        artifactType: 'screenshot',
        status: 'failed',
        errorMessage: 'screenshot result missing for https://example.com/docs',
      }),
    ]);
    expect(sitePageCalls).toEqual([
      expect.objectContaining({ artifactType: 'markdown', status: 'succeeded' }),
      expect.objectContaining({ artifactType: 'screenshot', status: 'failed' }),
    ]);
  });

  it('throws when artifact-only task has no pageRunId', async () => {
    const executor = {
      capture: async () => makeMarkdownCaptureResult(),
    } as unknown as PageCaptureExecutor;

    const handler = createPageCaptureRequestHandler({
      executor,
      classifier: new FakeClassifier(),
      siteConfig,
      runType: 'crawl_run',
      updatePolicy: 'force_recrawl_all',
      staleAfterMs: null,
      pageCaptureQueue: makeNoopRequestQueue().queue,
      artifactWriter: makeArtifactWriter().writer,
      artifactRunRepository: makeArtifactRunRepository(),
      pageRunRepository: makePageRunRepository(),
      sitePageRepository: makeSitePageRepository(),
      runPlanner: makeNoopPlanner(),
      captureTools: defaultTestCaptureTools,
      runLog: noopRunLog,
    });

    await expect(
      handler({
        task: makeArtifactTask({ pageRunId: undefined }),
        runtime,
      }),
    ).rejects.toThrow('pageRunId');
  });
});

// ─────────────────────────── failed request handler ──────────────────────────

describe('createPageCaptureFailedRequestHandler – base task failure', () => {
  it('writes failed page_run, marks site_page failed, and logs error', async () => {
    const pageRunCalls: unknown[] = [];
    const pageRunRepository = makePageRunRepository({
      createFailed: async (args: unknown) => { pageRunCalls.push(args); return 1; },
    });

    const sitePageCalls: unknown[] = [];
    const sitePageRepository = makeSitePageRepository({
      recordBaseCaptureFailed: async (args: unknown) => { sitePageCalls.push(args); },
    });

    const logCalls: unknown[] = [];
    const runLog: RunLogRepository = {
      log: async (args: unknown) => { logCalls.push(args); },
    } as unknown as RunLogRepository;

    const handler = createPageCaptureFailedRequestHandler({
      artifactRunRepository: makeArtifactRunRepository(),
      pageRunRepository,
      sitePageRepository,
      runLog,
    });

    const task = makeBaseTask();
    await handler({
      task,
      request: { url: task.url },
      error: new Error('network timeout'),
    });

    expect(pageRunCalls).toHaveLength(1);
    expect((pageRunCalls[0] as { errorMessage: string }).errorMessage).toBe('network timeout');
    expect(sitePageCalls).toHaveLength(1);

    const events = (logCalls as Array<{ event: string; level: string }>);
    expect(events.some((e) => e.event === 'base_page_failed' && e.level === 'error')).toBe(true);
  });
});

describe('createPageCaptureFailedRequestHandler – artifact task failure', () => {
  it('writes failed artifact_run, marks site_page artifact failed, and logs error', async () => {
    const artifactRunCalls: unknown[] = [];
    const artifactRunRepository = makeArtifactRunRepository({
      create: async (args: unknown) => { artifactRunCalls.push(args); return 1; },
    });

    const sitePageCalls: unknown[] = [];
    const sitePageRepository = makeSitePageRepository({
      recordArtifactResult: async (args: unknown) => { sitePageCalls.push(args); },
    });

    const logCalls: unknown[] = [];
    const runLog: RunLogRepository = {
      log: async (args: unknown) => { logCalls.push(args); },
    } as unknown as RunLogRepository;

    const handler = createPageCaptureFailedRequestHandler({
      artifactRunRepository,
      pageRunRepository: makePageRunRepository(),
      sitePageRepository,
      runLog,
    });

    const task = makeArtifactTask({ needs: ['markdown'], pageRunId: 999 });
    await handler({
      task,
      request: { url: task.url },
      error: new Error('lightpanda crash'),
    });

    expect(artifactRunCalls).toHaveLength(1);
    expect((artifactRunCalls[0] as { status: string; artifactType: string }).status).toBe('failed');
    expect((artifactRunCalls[0] as { artifactType: string }).artifactType).toBe('markdown');

    expect(sitePageCalls).toHaveLength(1);
    expect((sitePageCalls[0] as { status: string }).status).toBe('failed');

    const events = (logCalls as Array<{ event: string; level: string }>);
    expect(events.some((e) => e.event === 'artifact_failed' && e.level === 'error')).toBe(true);
  });

  it('throws when artifact task has no pageRunId', async () => {
    const handler = createPageCaptureFailedRequestHandler({
      artifactRunRepository: makeArtifactRunRepository(),
      pageRunRepository: makePageRunRepository(),
      sitePageRepository: makeSitePageRepository(),
      runLog: noopRunLog,
    });

    const task = makeArtifactTask({ pageRunId: undefined });
    await expect(
      handler({ task, request: { url: task.url }, error: new Error('fail') }),
    ).rejects.toThrow('fail');
  });
});
