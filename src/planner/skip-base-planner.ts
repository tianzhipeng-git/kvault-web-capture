import type { ArtifactRunRepository, PageRunRepository } from '../db/repositories/index.js';
import { expandArtifactRequirements, reusableHistoricalArtifactStatus } from '../domain/artifact-requirements.js';
import type { ArtifactRequirement, HistoricalPageState, SiteConfig, UpdatePolicy } from '../domain/types.js';
import { buildStage2EnqueueDecision } from '../rules/rule-decision.js';

export type SkipBaseArtifactPlan =
  | { pageRunId: null; requirements: []; reason: 'missing_base' }
  | { pageRunId: number; requirements: ArtifactRequirement[]; reason: 'ready' | 'stage_denied' };

export async function planArtifactsWithoutBase(input: {
  siteId: number;
  sitePageId: number;
  normalizedUrl: string;
  siteConfig: SiteConfig;
  updatePolicy: UpdatePolicy;
  staleAfterMs: number | null;
  history: HistoricalPageState | null;
  pageRuns: PageRunRepository;
  artifactRuns: ArtifactRunRepository;
  nowIsoString: string;
}): Promise<SkipBaseArtifactPlan> {
  const historicalBase = await input.pageRuns.getLatestSuccessfulBase(
    input.siteId,
    input.sitePageId,
  );
  if (!historicalBase || !input.history || input.history.latestClassificationLabels === null) {
    return { pageRunId: null, requirements: [], reason: 'missing_base' };
  }

  const stageDecision = buildStage2EnqueueDecision({
    runType: 'crawl_run',
    url: input.normalizedUrl,
    siteConfig: input.siteConfig,
    classification: { labels: input.history.latestClassificationLabels },
  });
  if (stageDecision.pageOutcome !== 'allow') {
    return { pageRunId: historicalBase.pageRunId, requirements: [], reason: 'stage_denied' };
  }

  const requirements: ArtifactRequirement[] = [];
  for (const requirement of expandArtifactRequirements(
    stageDecision.requiredArtifacts,
    input.siteConfig,
  )) {
    const latest = await input.artifactRuns.latestStatus({
      sitePageId: input.sitePageId,
      requirement,
    });
    const reusable = latest === null
      ? null
      : reusableHistoricalArtifactStatus({
          policy: input.updatePolicy,
          status: latest.status,
          finishedAt: latest.finishedAt,
          referenceTime: input.nowIsoString,
          staleAfterMs: input.staleAfterMs,
        });
    if (reusable === null) {
      requirements.push(requirement);
    }
  }

  return { pageRunId: historicalBase.pageRunId, requirements, reason: 'ready' };
}
