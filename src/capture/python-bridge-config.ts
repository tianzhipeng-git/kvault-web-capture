/** Python subprocess wall-clock limit shared by scrapling-page and crawl4ai-page. */
export const PYTHON_BRIDGE_TIMEOUT_MS = 120_000;

/** Crawlee handler timeout must exceed the Python bridge so reclaim does not orphan subprocesses. */
export const REQUEST_HANDLER_TIMEOUT_SECS = Math.ceil(PYTHON_BRIDGE_TIMEOUT_MS / 1000) + 15;
