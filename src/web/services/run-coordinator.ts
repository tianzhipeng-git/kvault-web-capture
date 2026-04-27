import type { M1App } from '../../app/services.js';
import type { SpikeRunSummary, UpdatePolicy } from '../../domain/types.js';

interface ActiveRun {
  siteId: number;
  kind: 'seed' | 'crawl';
  startedAt: string;
  promise: Promise<SpikeRunSummary>;
}

export class RunCoordinator {
  private readonly activeRuns = new Map<number, ActiveRun>();

  constructor(private readonly maxConcurrentRuns: number) {}

  isSiteBusy(siteId: number): boolean {
    return this.activeRuns.has(siteId);
  }

  listActiveRuns(): Array<{ siteId: number; kind: 'seed' | 'crawl'; startedAt: string }> {
    return [...this.activeRuns.values()].map((run) => ({
      siteId: run.siteId,
      kind: run.kind,
      startedAt: run.startedAt,
    }));
  }

  startSeed(app: M1App, siteId: number): Promise<SpikeRunSummary> {
    return this.start(siteId, 'seed', () => app.runSeed(siteId));
  }

  startCrawl(
    app: M1App,
    input: {
      siteId: number;
      updatePolicy: UpdatePolicy;
      targetSuccessCount: number | null;
      staleAfterMs: number | null;
      initialUrls: string[] | null;
      crawlMaxDepthOverride: number | null;
    },
  ): Promise<SpikeRunSummary> {
    return this.start(input.siteId, 'crawl', () => app.runCrawl(input));
  }

  private start(
    siteId: number,
    kind: 'seed' | 'crawl',
    run: () => Promise<SpikeRunSummary>,
  ): Promise<SpikeRunSummary> {
    if (this.activeRuns.has(siteId)) {
      throw new Error('当前站点已有运行中的任务，请等待完成后再重新发起。');
    }

    if (this.activeRuns.size >= this.maxConcurrentRuns) {
      throw new Error('当前服务器正在处理较多任务，请稍后再试。');
    }

    const promise = run().finally(() => {
      this.activeRuns.delete(siteId);
    });

    this.activeRuns.set(siteId, {
      siteId,
      kind,
      startedAt: new Date().toISOString(),
      promise,
    });

    return promise;
  }
}
