import type { SiteConfig } from '../domain/types.js';

const DEFAULT_CAPTURE_CONCURRENCY = 5;
const CDP_TOOLS = new Set(['crawl4ai-page', 'scrapling-page']);

export function resolveCaptureConcurrency(siteConfig: SiteConfig): number {
  const usesPythonCdpTool = siteConfig.captureProfile?.tools.some((tool) => CDP_TOOLS.has(tool)) ?? false;
  if (!usesPythonCdpTool) {
    return DEFAULT_CAPTURE_CONCURRENCY;
  }

  return siteConfig.browser?.cdpPoolSize ?? 1;
}
