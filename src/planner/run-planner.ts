import type { PlannedRun } from '../domain/types.js';
import { normalizeUrl } from '../utils/url.js';
import { RunRepository, SitePageRepository, SiteRepository } from '../db/repositories.js';

export class RunPlanner {
  constructor(
    private readonly siteRepository: SiteRepository,
    private readonly runRepository: RunRepository,
    private readonly sitePageRepository: SitePageRepository,
  ) {}

  plan(input: { seedUrl: string; siteName?: string }): PlannedRun {
    const seedUrl = new URL(input.seedUrl).toString();
    const rootUrl = new URL(seedUrl).origin;
    const siteName = input.siteName ?? new URL(seedUrl).hostname;
    const siteId = this.siteRepository.ensureSite(siteName, rootUrl);
    const normalizedUrl = normalizeUrl(seedUrl);
    const runId = this.runRepository.createRun(siteId, seedUrl);
    const sitePageId = this.sitePageRepository.createOrGet(siteId, seedUrl, normalizedUrl);

    return {
      runId,
      siteId,
      sitePageId,
      normalizedUrl,
    };
  }
}
