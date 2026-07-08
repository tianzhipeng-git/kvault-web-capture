import type { CaptureApp } from '../../app/capture-app.js';
import type { RunSummary, UpdatePolicy } from '../../domain/types.js';

interface ActiveRun {
  runId: number | null;
  siteId: number;
  kind: 'seed' | 'crawl';
  startedAt: string;
  abortController: AbortController;
}

export class RunCoordinator {
  private readonly activeRuns = new Map<number, ActiveRun>();

  private readonly activeRunIds = new Map<number, ActiveRun>();

  constructor(private readonly maxConcurrentRuns: number) {}

  isSiteBusy(siteId: number): boolean {
    return this.activeRuns.has(siteId);
  }

  listActiveRuns(): Array<{ runId: number | null; siteId: number; kind: 'seed' | 'crawl'; startedAt: string }> {
    return [...this.activeRuns.values()].map((run) => ({
      runId: run.runId,
      siteId: run.siteId,
      kind: run.kind,
      startedAt: run.startedAt,
    }));
  }

  startSeed(
    app: CaptureApp,
    input: {
      siteId: number;
      targetSuccessCount: number | null;
    },
  ): Promise<RunSummary> {
    return this.start(input.siteId, 'seed', (abortSignal) => app.runSeed({ ...input, abortSignal }));
  }

  startCrawl(
    app: CaptureApp,
    input: {
      siteId: number;
      updatePolicy: UpdatePolicy;
      targetSuccessCount: number | null;
      staleAfterMs: number | null;
      initialUrls: string[] | null;
      crawlMaxDepthOverride: number | null;
    },
  ): Promise<RunSummary> {
    return this.start(input.siteId, 'crawl', (abortSignal) => app.runCrawl({ ...input, abortSignal }));
  }

  attachRunId(siteId: number, runId: number): void {
    const activeRun = this.activeRuns.get(siteId);

    if (!activeRun) {
      return;
    }

    if (activeRun.runId !== null) {
      this.activeRunIds.delete(activeRun.runId);
    }

    activeRun.runId = runId;
    this.activeRunIds.set(runId, activeRun);
  }

  cancelRun(runId: number): boolean {
    const activeRun = this.activeRunIds.get(runId);

    if (!activeRun) {
      return false;
    }

    activeRun.abortController.abort();
    return true;
  }

  cancelRunForSite(runId: number, siteId: number): boolean {
    const activeRunById = this.activeRunIds.get(runId);
    if (activeRunById) {
      activeRunById.abortController.abort();
      return true;
    }

    const activeRun = this.activeRuns.get(siteId);
    if (!activeRun || (activeRun.runId !== null && activeRun.runId !== runId)) {
      return false;
    }

    activeRun.runId = runId;
    this.activeRunIds.set(runId, activeRun);
    activeRun.abortController.abort();
    return true;
  }

  private start(
    siteId: number,
    kind: 'seed' | 'crawl',
    run: (abortSignal: AbortSignal) => Promise<RunSummary>,
  ): Promise<RunSummary> {
    if (this.activeRuns.has(siteId)) {
      throw new Error('当前站点已有运行中的任务，请等待完成后再重新发起。');
    }

    if (this.activeRuns.size >= this.maxConcurrentRuns) {
      throw new Error('当前服务器正在处理较多任务，请稍后再试。');
    }

    const abortController = new AbortController();
    const activeRun: ActiveRun = {
      runId: null,
      siteId,
      kind,
      startedAt: new Date().toISOString(),
      abortController,
    };

    this.activeRuns.set(siteId, activeRun);

    const promise = Promise.resolve().then(() => run(abortController.signal)).finally(() => {
      this.activeRuns.delete(siteId);
      if (activeRun.runId !== null) {
        this.activeRunIds.delete(activeRun.runId);
      }
    });

    return promise;
  }
}
