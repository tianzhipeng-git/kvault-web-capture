import type { Configuration, RequestQueue } from 'crawlee';
import { RequestQueue as CrawleeRequestQueue } from 'crawlee';

export type QueueStage = 'base' | 'markdown' | 'screenshot';

export function buildQueueName(runId: number, stage: QueueStage): string {
  return `run-${runId}-${stage}`;
}

export async function openRunQueue(
  runId: number,
  stage: QueueStage,
  configuration: Configuration,
): Promise<RequestQueue> {
  return CrawleeRequestQueue.open(buildQueueName(runId, stage), {
    config: configuration,
  });
}
