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
  };
}

export interface CrawlRunFormInput {
  updatePolicy?: UpdatePolicy;
  targetSuccessCount?: number | null;
  staleAfterMs?: number | null;
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
    },
  });
}

export function mapRunForm(input: CrawlRunFormInput): {
  updatePolicy: UpdatePolicy;
  targetSuccessCount: number | null;
  staleAfterMs: number | null;
} {
  return {
    updatePolicy: input.updatePolicy ?? 'force_recrawl_all',
    targetSuccessCount: input.targetSuccessCount ?? null,
    staleAfterMs: input.staleAfterMs ?? null,
  };
}
