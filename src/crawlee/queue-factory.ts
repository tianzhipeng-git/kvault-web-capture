import type { Configuration, RequestQueue } from 'crawlee';
import { RequestQueue as CrawleeRequestQueue } from 'crawlee';

export type QueueStage = 'page-capture';

export function buildQueueName(runId: number): string {
  return `run-${runId}-page-capture`;
}

export async function openRunQueue(
  runId: number,
  _stage: QueueStage,
  configuration: Configuration,
): Promise<RequestQueue> {
  return CrawleeRequestQueue.open(buildQueueName(runId), {
    config: configuration,
  });
}
