export class RunCancelledError extends Error {
  constructor(message = 'Run cancelled by user') {
    super(message);
    this.name = 'RunCancelledError';
  }
}

export function isRunCancelledError(error: unknown): error is RunCancelledError {
  return error instanceof RunCancelledError || (
    error instanceof Error && error.name === 'RunCancelledError'
  );
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new RunCancelledError();
  }
}

export function combineAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);

  if (activeSignals.length === 0) {
    return undefined;
  }

  if (activeSignals.length === 1) {
    return activeSignals[0];
  }

  const controller = new AbortController();
  const abort = () => {
    controller.abort();
    for (const signal of activeSignals) {
      signal.removeEventListener('abort', abort);
    }
  };

  for (const signal of activeSignals) {
    if (signal.aborted) {
      abort();
      return controller.signal;
    }
    signal.addEventListener('abort', abort, { once: true });
  }

  return controller.signal;
}
