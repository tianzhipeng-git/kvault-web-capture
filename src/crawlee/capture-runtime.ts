import { BasicCrawler, type Configuration, type RequestQueue } from 'crawlee';

import type { RuntimeContext } from '../capture/types.js';
import type { PageCaptureTask } from '../domain/types.js';

const SESSION_POOL_OPTIONS = {
  maxPoolSize: 50,
} as const;

const ANTI_BLOCKING_OPTIONS = {
  retryOnBlocked: true,
  sameDomainDelaySecs: 1,
} as const;

export interface CrawleeCaptureRuntimeOptions {
  requestQueue: RequestQueue;
  configuration: Configuration;
  maxConcurrency?: number;
  requestHandlerTimeoutSecs?: number;
  requestHandler: (input: {
    task: PageCaptureTask;
    request: { id?: string; url: string };
    runtime: RuntimeContext;
  }) => Promise<void>;
  failedRequestHandler: (input: {
    task: PageCaptureTask;
    request: { url: string };
    error: Error;
  }) => Promise<void>;
}

export class CrawleeCaptureRuntime {
  private readonly crawler: BasicCrawler;

  constructor(options: CrawleeCaptureRuntimeOptions) {
    const handlerTimeoutSecs = options.requestHandlerTimeoutSecs ?? 60;

    this.crawler = new BasicCrawler(
      {
        requestQueue: options.requestQueue,
        maxConcurrency: options.maxConcurrency ?? 5,
        requestHandlerTimeoutSecs: handlerTimeoutSecs,
        ...ANTI_BLOCKING_OPTIONS,
        sessionPoolOptions: SESSION_POOL_OPTIONS,
        requestHandler: async (context) => {
          const request = context.request;
          const task = request.userData as PageCaptureTask;
          const sendRequest = async (url: string, requestOptions?: Record<string, unknown>) =>
            context.sendRequest({
              url,
              ...(requestOptions ?? {}),
            });

          await options.requestHandler({
            task,
            request: {
              id: request.id,
              url: request.url,
            },
            runtime: {
              requestId: request.id ?? request.uniqueKey,
              sendRequest,
              session: context.session,
              proxyInfo: context.proxyInfo
                ? {
                    url: context.proxyInfo.url,
                    hostname: context.proxyInfo.hostname,
                    port: typeof context.proxyInfo.port === 'number'
                      ? context.proxyInfo.port
                      : undefined,
                  }
                : undefined,
              abortSignal: AbortSignal.timeout(handlerTimeoutSecs * 1000),
            },
          });
        },
        failedRequestHandler: async (context, error) => {
          await options.failedRequestHandler({
            task: context.request.userData as PageCaptureTask,
            request: { url: context.request.url },
            error,
          });
        },
      },
      options.configuration,
    );
  }

  async run(): Promise<void> {
    await this.crawler.run();
  }
}
