import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import pino, { type Logger as PinoLogger } from 'pino';
import { LoggerJson, log as crawleeLog } from 'crawlee';

interface RuntimeLogDestination {
  write: (line: string) => unknown;
  flush?: (callback?: () => void) => void;
  flushSync?: () => void;
  end?: () => void;
}

export interface RuntimeLogHandle {
  relativePath: string;
  absolutePath: string;
  logger: PinoLogger;
  destination: RuntimeLogDestination;
  close: () => Promise<void>;
}

interface RuntimeLogContext {
  logger: PinoLogger;
  destination: RuntimeLogDestination;
}

const runtimeLogContext = new AsyncLocalStorage<RuntimeLogContext>();

class RuntimeCrawleeLogger extends LoggerJson {
  override _outputWithConsole(level: number, line: string): void {
    const context = runtimeLogContext.getStore();

    if (!context) {
      super._outputWithConsole(level, line);
      return;
    }

    context.destination.write(`${line}\n`);
  }
}

let crawleeBridgeInstalled = false;

function installCrawleeLogBridge(): void {
  if (crawleeBridgeInstalled) {
    return;
  }

  crawleeLog.setOptions({
    logger: new RuntimeCrawleeLogger(),
  });
  crawleeBridgeInstalled = true;
}

export async function openRuntimeLog(input: {
  storageRoot: string;
  runId: number;
}): Promise<RuntimeLogHandle> {
  installCrawleeLogBridge();

  const relativePath = ['runs', String(input.runId), 'runtime.log'].join('/');
  const absolutePath = join(input.storageRoot, ...relativePath.split('/'));

  await mkdir(join(input.storageRoot, 'runs', String(input.runId)), { recursive: true });

  const destination = pino.destination({
    dest: absolutePath,
    append: true,
    mkdir: true,
    sync: false,
  });
  const logger = pino(
    {
      base: {
        source: 'app',
        crawlRunId: input.runId,
      },
      level: process.env.KVAULT_LOG_LEVEL ?? 'info',
    },
    destination,
  );

  return {
    relativePath,
    absolutePath,
    logger,
    destination,
    close: async () => {
      await new Promise<void>((resolve) => {
        if (destination.flush) {
          destination.flush(() => resolve());
          return;
        }
        destination.flushSync?.();
        resolve();
      });
      destination.end?.();
    },
  };
}

export async function withRuntimeLog<T>(
  handle: RuntimeLogHandle,
  callback: () => Promise<T>,
): Promise<T> {
  return runtimeLogContext.run(
    {
      logger: handle.logger,
      destination: handle.destination,
    },
    callback,
  );
}

export const logger = {
  info(message: string, meta?: Record<string, unknown>): void {
    const context = runtimeLogContext.getStore();

    if (!context) {
      console.info(message, meta ?? '');
      return;
    }

    context.logger.info(meta ?? {}, message);
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    const context = runtimeLogContext.getStore();

    if (!context) {
      console.warn(message, meta ?? '');
      return;
    }

    context.logger.warn(meta ?? {}, message);
  },
  error(message: string, meta?: Record<string, unknown>): void {
    const context = runtimeLogContext.getStore();

    if (!context) {
      console.error(message, meta ?? '');
      return;
    }

    context.logger.error(meta ?? {}, message);
  },
};
