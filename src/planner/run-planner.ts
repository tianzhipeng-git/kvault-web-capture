import type {
  PlannedRequest,
  RunType,
  SiteConfig,
  UpdatePolicy,
} from '../domain/types.js';
import { SitePageRepository } from '../db/repositories/index.js';
import { shouldEnqueueByUpdatePolicy } from './update-policy.js';
import { buildBaseEnqueueDecision, buildStage2EnqueueDecision } from '../rules/rule-decision.js';
import { normalizeUrl } from '../utils/url.js';
import type { Clock } from '../utils/clock.js';

export class RunPlanner {
  constructor(
    private readonly sitePageRepository: SitePageRepository,
    private readonly clock: Clock,
  ) { }

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

    // 规则执行点1, rulesBeforeBaseEq
    const baseDecision = buildBaseEnqueueDecision({
      url: normalizedUrl,
      siteConfig: input.siteConfig,
    });
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
          baseDecision.urlRuleDecision === 'deny' ? 'url_rule_denied' : 'discovered_only',
        urlRuleDecision: baseDecision.urlRuleDecision,
      });

    if (!baseDecision.enqueue) {
      this.sitePageRepository.markUrlRuleDenied(sitePageId);
      return {
        siteId: input.siteId,
        sitePageId,
        normalizedUrl,
        enqueue: false,
        urlRuleDecision: 'deny',
        planReason: "baseDecision: " + baseDecision.reason,
      };
    } // 规则执行点1判断不入队, 直接跳过后续

    if (input.runType === 'seed_run') {
      return {
        siteId: input.siteId,
        sitePageId,
        normalizedUrl,
        enqueue: true,
        urlRuleDecision: 'allow',
        planReason: "seed_run",
      };
    } // seed_run的话, 直接入base队, 深度爬取队不会启动.


    // 虽然本方法是判断是否要入Base队列, 但是为了应用Update Policy, 需要判断Stage2的规则结果
    const classificationLabels = existingState?.latestClassificationLabels ?? null;
    const currentStageDecision =
      classificationLabels === null
        ? null
        : (() => {
          const decision = buildStage2EnqueueDecision({
            runType: 'crawl_run',
            url: normalizedUrl,
            siteConfig: input.siteConfig,
            classification: {
              labels: classificationLabels,
            },
          });

          return {
            outcome: decision.pageOutcome,
            requiredArtifacts: decision.requiredArtifacts,
          };
        })();

    // 根据历史状态, 最新rulesBeforeStage2Eq的规则结果, 判断Update Policy是否允许入队
    const policyDecision = shouldEnqueueByUpdatePolicy({
      policy: input.updatePolicy,
      history: existingState,
      currentStageDecision,
      nowIsoString: this.clock.now(),
      staleAfterMs: input.staleAfterMs,
    });

    return {
      siteId: input.siteId,
      sitePageId,
      normalizedUrl,
      enqueue: policyDecision.enqueue,
      urlRuleDecision: 'allow',
      planReason: "Update Policy: " + policyDecision.reason,
    };
  }
}
