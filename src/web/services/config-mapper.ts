import { parseSiteConfig } from '../../config/site-config.js';
import type { SiteConfig, UpdatePolicy } from '../../domain/types.js';

export interface SiteConfigFormInput {
  seedUrls?: string[];
  sitemaps?: string[];
  rulesBeforeBaseEq?: SiteConfig['rulesBeforeBaseEq'];
  rulesBeforeStage2Eq?: SiteConfig['rulesBeforeStage2Eq'];
  runOptions?: {
    seedMaxDepth?: number;
    crawlMaxDepth?: number;
    maxRequestRetries?: number;
  };
  captureProfile?: SiteConfig['captureProfile'];
  urlNormalization?: SiteConfig['urlNormalization'];
  validation?: SiteConfig['validation'];
  browser?: SiteConfig['browser'];
  proxyPolicy?: SiteConfig['proxyPolicy'];
  screenshot?: SiteConfig['screenshot'];
}

export interface CrawlRunFormInput {
  updatePolicy?: UpdatePolicy;
  targetSuccessCount?: number | null;
  staleAfterMs?: number | null;
  initialUrls?: string[];
  crawlMaxDepthOverride?: number;
}

export function mapConfigFormToSiteConfig(input: SiteConfigFormInput): SiteConfig {
  return parseSiteConfig({
    seedUrls: input.seedUrls ?? [],
    sitemaps: input.sitemaps ?? [],
    rulesBeforeBaseEq: input.rulesBeforeBaseEq ?? [],
    rulesBeforeStage2Eq: input.rulesBeforeStage2Eq ?? [],
    runOptions: {
      seedMaxDepth: input.runOptions?.seedMaxDepth ?? 1,
      crawlMaxDepth: input.runOptions?.crawlMaxDepth ?? 2,
      maxRequestRetries: input.runOptions?.maxRequestRetries ?? 3,
    },
    captureProfile: input.captureProfile,
    urlNormalization: input.urlNormalization,
    validation: input.validation,
    browser: input.browser,
    proxyPolicy: input.proxyPolicy,
    screenshot: input.screenshot,
  });
}

export function mapRunForm(input: CrawlRunFormInput): {
  updatePolicy: UpdatePolicy;
  targetSuccessCount: number | null;
  staleAfterMs: number | null;
  initialUrls: string[] | null;
  crawlMaxDepthOverride: number | null;
} {
  return {
    updatePolicy: input.updatePolicy ?? 'force_recrawl_all',
    targetSuccessCount: input.targetSuccessCount ?? null,
    staleAfterMs: input.staleAfterMs ?? null,
    initialUrls: Array.isArray(input.initialUrls) && input.initialUrls.length > 0
      ? (input.initialUrls as unknown[]).filter((u): u is string => typeof u === 'string')
      : null,
    crawlMaxDepthOverride: typeof input.crawlMaxDepthOverride === 'number' ? input.crawlMaxDepthOverride : null,
  };
}
