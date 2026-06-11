import { describe, expect, it } from 'vitest';

import { RunCoordinator } from '../src/web/services/run-coordinator.js';
import type { RunSummary } from '../src/domain/types.js';

function createSummary(runId: number): RunSummary {
  return {
    runId,
    siteId: 1,
    sitePageId: 1,
    normalizedUrl: 'https://example.com',
    pageRuns: 0,
    artifactRuns: 0,
  };
}

describe('RunCoordinator', () => {
  it('cancels an active run by run id', async () => {
    const coordinator = new RunCoordinator(1);
    const receivedSignal: { value: AbortSignal | null } = { value: null };
    const resolveRun: { value: ((summary: RunSummary) => void) | null } = { value: null };
    const app = {
      runCrawl: (input: { abortSignal?: AbortSignal }) => {
        receivedSignal.value = input.abortSignal ?? null;
        return new Promise<RunSummary>((resolve) => {
          resolveRun.value = resolve;
        });
      },
    };

    const promise = coordinator.startCrawl(app as never, {
      siteId: 1,
      updatePolicy: 'force_recrawl_all',
      targetSuccessCount: null,
      staleAfterMs: null,
      initialUrls: null,
      crawlMaxDepthOverride: null,
    });

    await Promise.resolve();
    coordinator.attachRunId(1, 123);

    expect(coordinator.cancelRun(123)).toBe(true);
    expect(receivedSignal.value?.aborted).toBe(true);

    resolveRun.value?.(createSummary(123));
    await expect(promise).resolves.toEqual(createSummary(123));
  });

  it('does not cancel unknown or completed run ids', async () => {
    const coordinator = new RunCoordinator(1);

    expect(coordinator.cancelRun(123)).toBe(false);
  });
});
