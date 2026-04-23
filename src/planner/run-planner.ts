import type {
  ClassificationResult,
  PlannedRequest,
  RunType,
  SiteConfig,
  StageDecisionSnapshot,
  UpdatePolicy,
} from '../domain/types.js';
import { SitePageRepository } from '../db/repositories.js';
import { shouldEnqueueByUpdatePolicy } from './update-policy.js';
import { evaluateTagRules, evaluateUrlRules } from '../rules/rule-decision.js';
import { normalizeUrl } from '../utils/url.js';
import type { Clock } from '../utils/clock.js';

function buildCurrentStageDecision(
  classificationTags: Record<string, string[]> | null,
  siteConfig: SiteConfig,
): StageDecisionSnapshot | null {
  if (classificationTags === null) {
    return null;
  }

  const tagEvaluation = evaluateTagRules(
    {
      tags: classificationTags,
    } satisfies ClassificationResult,
    siteConfig.tagRules,
  );

  if (tagEvaluation.outcome === 'allow') {
    return {
      outcome: 'allow',
      requiredArtifacts: tagEvaluation.requiredArtifacts,
    };
  }

  return {
    outcome: tagEvaluation.outcome,
    requiredArtifacts: [],
  };
}

export class RunPlanner {
  constructor(
    private readonly sitePageRepository: SitePageRepository,
    private readonly clock: Clock,
  ) {}

  planRequest(input: {
    siteId: number;
    discoveredUrl: string;
    discoverySource: string;
    discoveryReferrerUrl: string | null;
    siteConfig: SiteConfig;
    runType: RunType;
    updatePolicy: UpdatePolicy;
    staleAfterMs: number | null;
  }): PlannedRequest {
    const normalizedUrl = normalizeUrl(input.discoveredUrl);
    const urlRuleDecision = evaluateUrlRules(normalizedUrl, input.siteConfig.urlRules);
    const existingState = this.sitePageRepository.getHistoricalState(input.siteId, normalizedUrl);
    const sitePageId =
      existingState?.sitePageId ??
      this.sitePageRepository.upsertDiscovery({
        siteId: input.siteId,
        discoveredUrl: input.discoveredUrl,
        normalizedUrl,
        discoverySource: input.discoverySource,
        discoveryReferrerUrl: input.discoveryReferrerUrl,
        inventoryStatus:
          urlRuleDecision.outcome === 'deny' ? 'url_rule_denied' : 'discovered_only',
        urlRuleDecision: urlRuleDecision.outcome,
      });

    if (urlRuleDecision.outcome === 'deny') {
      this.sitePageRepository.markUrlRuleDenied(sitePageId);
      return {
        siteId: input.siteId,
        sitePageId,
        normalizedUrl,
        enqueue: false,
        urlRuleDecision: 'deny',
        skipReason: urlRuleDecision.reason,
      };
    }

    if (input.runType === 'seed_run') {
      return {
        siteId: input.siteId,
        sitePageId,
        normalizedUrl,
        enqueue: true,
        urlRuleDecision: 'allow',
        skipReason: null,
      };
    }

    const policyDecision = shouldEnqueueByUpdatePolicy({
      policy: input.updatePolicy,
      history: existingState,
      currentStageDecision: buildCurrentStageDecision(
        existingState?.latestClassificationTags ?? null,
        input.siteConfig,
      ),
      nowIsoString: this.clock.now(),
      staleAfterMs: input.staleAfterMs,
    });

    return {
      siteId: input.siteId,
      sitePageId,
      normalizedUrl,
      enqueue: policyDecision.enqueue,
      urlRuleDecision: 'allow',
      skipReason: policyDecision.reason,
    };
  }
}
