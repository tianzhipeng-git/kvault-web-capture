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
import { expandArtifactRequirements } from '../domain/artifact-requirements.js';

export class RunPlanner {
  constructor(
    private readonly sitePageRepository: SitePageRepository,
    private readonly clock: Clock,
  ) { }

  async planRequest(input: {
    siteId: number;
    discoveredUrl: string;
    discoverySource: string;
    discoveryReferrerUrl: string | null;
    siteConfig: SiteConfig;
    runType: RunType;
    updatePolicy: UpdatePolicy;
    staleAfterMs: number | null;
  }): Promise<PlannedRequest> {
    const normalizedUrl = normalizeUrl(input.discoveredUrl, input.siteConfig.urlNormalization);

    // 规则执行点1, rulesBeforeBaseEq
    const baseDecision = buildBaseEnqueueDecision({
      url: normalizedUrl,
      siteConfig: input.siteConfig,
    });
    const existingState = await this.sitePageRepository.getHistoricalState(input.siteId, normalizedUrl);
    const sitePageId =
      existingState?.sitePageId ??
      await this.sitePageRepository.upsertDiscovery({
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
      await this.sitePageRepository.markUrlRuleDenied(sitePageId);
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
    let completeScreenshotRequiresCapture = false;
    if (
      input.updatePolicy !== 'force_recrawl_all' &&
      input.siteConfig.screenshot?.mode === 'complete' &&
      currentStageDecision?.outcome === 'allow' &&
      currentStageDecision.requiredArtifacts.includes('screenshot')
    ) {
      const requirements = expandArtifactRequirements(
        currentStageDecision.requiredArtifacts,
        input.siteConfig,
      ).filter((requirement) => requirement.artifactType === 'screenshot');
      for (const requirement of requirements) {
        const latest = await this.sitePageRepository.getLatestRequirementStatus({
          sitePageId,
          requirement,
        });
        const stale =
          input.updatePolicy === 'stale_after_duration' &&
          latest !== null &&
          new Date(this.clock.now()).getTime() -
            new Date(latest.finishedAt).getTime() >= (input.staleAfterMs ?? 0);
        if (latest?.status !== 'succeeded' || stale) {
          completeScreenshotRequiresCapture = true;
          break;
        }
      }
    }

    return {
      siteId: input.siteId,
      sitePageId,
      normalizedUrl,
      enqueue: policyDecision.enqueue || completeScreenshotRequiresCapture,
      urlRuleDecision: 'allow',
      planReason: completeScreenshotRequiresCapture
        ? 'complete screenshot requirements require variant-level planning'
        : "Update Policy: " + policyDecision.reason,
    };
  }
}
