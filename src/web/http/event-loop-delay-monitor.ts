import { monitorEventLoopDelay } from 'node:perf_hooks';

export const DEFAULT_EVENT_LOOP_DELAY_INTERVAL_MS = 5000;
export const DEFAULT_EVENT_LOOP_DELAY_THRESHOLD_MS = 100;

export interface EventLoopDelaySnapshot {
  intervalMs: number;
  thresholdMs: number;
  minMs: number;
  meanMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  activeRunCount: number;
  createdAt: string;
}

export interface EventLoopDelayMonitorHandle {
  getSnapshot(): EventLoopDelaySnapshot | null;
  close(): void;
}

function nanosecondsToMs(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Number((value / 1_000_000).toFixed(2));
}

export function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function startEventLoopDelayMonitor(input: {
  intervalMs: number;
  thresholdMs: number;
  getActiveRunCount: () => number;
}): EventLoopDelayMonitorHandle {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  let latestSnapshot: EventLoopDelaySnapshot | null = null;

  histogram.enable();

  const interval = setInterval(() => {
    const activeRunCount = input.getActiveRunCount();
    const snapshot: EventLoopDelaySnapshot = {
      intervalMs: input.intervalMs,
      thresholdMs: input.thresholdMs,
      minMs: nanosecondsToMs(histogram.min),
      meanMs: nanosecondsToMs(histogram.mean),
      maxMs: nanosecondsToMs(histogram.max),
      p50Ms: nanosecondsToMs(histogram.percentile(50)),
      p95Ms: nanosecondsToMs(histogram.percentile(95)),
      p99Ms: nanosecondsToMs(histogram.percentile(99)),
      activeRunCount,
      createdAt: new Date().toISOString(),
    };

    latestSnapshot = snapshot;

    if (activeRunCount > 0 || snapshot.p99Ms >= input.thresholdMs) {
      const log = snapshot.p99Ms >= input.thresholdMs ? console.warn : console.info;
      log('[web] event_loop_delay', snapshot);
    }

    histogram.reset();
  }, input.intervalMs);

  interval.unref?.();

  return {
    getSnapshot: () => latestSnapshot,
    close: () => {
      clearInterval(interval);
      histogram.disable();
    },
  };
}
