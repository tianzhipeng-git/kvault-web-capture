/** Default Python subprocess wall-clock limit. */
export const PYTHON_BRIDGE_TIMEOUT_MS = 120_000;

/** Scrapling often waits on browser navigation and anti-bot handling for real sites. */
export const SCRAPLING_PYTHON_BRIDGE_TIMEOUT_MS = 180_000;

/** Crawlee handler timeout must exceed the longest Python bridge so reclaim does not orphan subprocesses. */
export const REQUEST_HANDLER_TIMEOUT_SECS =
  Math.ceil(Math.max(PYTHON_BRIDGE_TIMEOUT_MS, SCRAPLING_PYTHON_BRIDGE_TIMEOUT_MS) / 1000) + 15;
