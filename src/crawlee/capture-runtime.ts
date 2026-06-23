import { BasicCrawler, type Configuration, type RequestQueue } from 'crawlee';

import { REQUEST_HANDLER_TIMEOUT_SECS } from '../capture/python-bridge-config.js';
import type { RuntimeContext } from '../capture/types.js';
import type { PageCaptureTask } from '../domain/types.js';
import { combineAbortSignals, RunCancelledError, throwIfAborted } from '../utils/cancellation.js';

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
  maxRequestRetries?: number;
  requestHandlerTimeoutSecs?: number;
  abortSignal?: AbortSignal;
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

  private readonly abortSignal?: AbortSignal;

  constructor(options: CrawleeCaptureRuntimeOptions) {
    const handlerTimeoutSecs = options.requestHandlerTimeoutSecs ?? REQUEST_HANDLER_TIMEOUT_SECS;
    this.abortSignal = options.abortSignal;

    this.crawler = new BasicCrawler(
      {
        requestQueue: options.requestQueue,
        maxConcurrency: options.maxConcurrency ?? 5,
        maxRequestRetries: options.maxRequestRetries ?? 3,
        requestHandlerTimeoutSecs: handlerTimeoutSecs,
        ...ANTI_BLOCKING_OPTIONS,
        sessionPoolOptions: SESSION_POOL_OPTIONS,
        requestHandler: async (context) => {
          throwIfAborted(this.abortSignal);

          const request = context.request;
          const task = request.userData as PageCaptureTask;
          const requestAbortSignal = combineAbortSignals([
            this.abortSignal,
            AbortSignal.timeout(handlerTimeoutSecs * 1000),
          ]);
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
              abortSignal: requestAbortSignal,
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
    throwIfAborted(this.abortSignal);

    const onAbort = () => {
      void this.crawler.teardown();
    };

    this.abortSignal?.addEventListener('abort', onAbort, { once: true });

    try {
      await this.crawler.run();
    } catch (error) {
      if (this.abortSignal?.aborted) {
        throw new RunCancelledError();
      }

      throw error;
    } finally {
      this.abortSignal?.removeEventListener('abort', onAbort);
    }

    throwIfAborted(this.abortSignal);
  }
}
