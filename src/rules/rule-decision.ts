import type {
  ClassificationResult,
  RuleOutcome,
  RunType,
  SiteConfig,
  StageDecision,
  TagRule,
  TagRuleCondition,
  TagRuleEvaluation,
  UrlRule,
  UrlRuleEvaluation,
} from '../domain/types.js';

function uniqueSorted<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function comparableUrl(input: string): string {
  const url = new URL(input);
  return `${url.host}${url.pathname}${url.search}`.replace(/\/$/, '');
}

function matchesUrlRule(url: string, rule: UrlRule): boolean {
  const comparable = comparableUrl(url);

  return rule.values.some((value) => {
    if (rule.ruleType === 'prefix') {
      return comparable.startsWith(value.replace(/^https?:\/\//, '').replace(/\/$/, ''));
    }

    return new RegExp(value).test(comparable);
  });
}

export function evaluateUrlRules(url: string, rules: UrlRule[]): UrlRuleEvaluation {
  for (const rule of rules.filter((item) => item.listType === 'blacklist')) {
    if (matchesUrlRule(url, rule)) {
      return {
        outcome: 'deny',
        matchedRuleName: rule.name,
        reason: `matched blacklist rule ${rule.name}`,
      };
    }
  }

  const scopeRules = rules.filter((item) => item.listType === 'scopelist');

  if (scopeRules.length === 0) {
    return {
      outcome: 'allow',
      matchedRuleName: null,
      reason: null,
    };
  }

  for (const rule of scopeRules) {
    if (matchesUrlRule(url, rule)) {
      return {
        outcome: 'allow',
        matchedRuleName: rule.name,
        reason: null,
      };
    }
  }

  return {
    outcome: 'deny',
    matchedRuleName: null,
    reason: 'outside scopelist',
  };
}

function matchesCondition(classification: ClassificationResult, condition: TagRuleCondition): boolean {
  const values = classification.tags[condition.key] ?? [];

  if (condition.op === 'is_empty') {
    return values.length === 0;
  }

  const requiredValues = condition.values ?? [];

  if (condition.op === 'any_of') {
    return requiredValues.some((value) => values.includes(value));
  }

  return requiredValues.every((value) => values.includes(value));
}

function matchesTagRule(classification: ClassificationResult, rule: TagRule): boolean {
  return rule.when.every((condition) => matchesCondition(classification, condition));
}

export function evaluateTagRules(
  classification: ClassificationResult,
  rules: TagRule[],
): TagRuleEvaluation {
  for (const rule of rules.filter((item) => item.listType === 'blacklist')) {
    if (matchesTagRule(classification, rule)) {
      return {
        outcome: 'deny',
        matchedRuleNames: [rule.name],
        requiredArtifacts: [],
        reason: `matched blacklist rule ${rule.name}`,
      };
    }
  }

  const matchedWhitelists = rules.filter(
    (rule) => rule.listType === 'whitelist' && matchesTagRule(classification, rule),
  );

  if (matchedWhitelists.length === 0) {
    return {
      outcome: 'pending',
      matchedRuleNames: [],
      requiredArtifacts: [],
      reason: 'no tag rule matched',
    };
  }

  return {
    outcome: 'allow',
    matchedRuleNames: matchedWhitelists.map((rule) => rule.name),
    requiredArtifacts: uniqueSorted(
      matchedWhitelists.flatMap((rule) => rule.artifacts),
    ),
    reason: null,
  };
}

export function buildStageDecision(input: {
  runType: RunType;
  siteConfig: SiteConfig;
  classification: ClassificationResult | null;
  classificationError?: Error | null;
}): StageDecision {
  if (input.classificationError || input.classification === null) {
    return {
      tagOutcome: 'pending',
      pageOutcome: 'pending',
      requiredArtifacts: [],
      reason: input.classificationError?.message ?? 'classifier failed',
      pendingReason: 'classifier_failed',
      matchedRuleNames: [],
    };
  }

  const tagEvaluation = evaluateTagRules(input.classification, input.siteConfig.tagRules);

  if (tagEvaluation.outcome === 'deny') {
    return {
      tagOutcome: 'deny',
      pageOutcome: 'deny',
      requiredArtifacts: [],
      reason: tagEvaluation.reason,
      pendingReason: null,
      matchedRuleNames: tagEvaluation.matchedRuleNames,
    };
  }

  if (input.runType === 'inventory_preview') {
    return {
      tagOutcome: tagEvaluation.outcome,
      pageOutcome: 'pending',
      requiredArtifacts: tagEvaluation.requiredArtifacts,
      reason: tagEvaluation.reason,
      pendingReason: 'preview_run',
      matchedRuleNames: tagEvaluation.matchedRuleNames,
    };
  }

  if (tagEvaluation.outcome === 'allow') {
    return {
      tagOutcome: 'allow',
      pageOutcome: 'allow',
      requiredArtifacts: tagEvaluation.requiredArtifacts,
      reason: null,
      pendingReason: null,
      matchedRuleNames: tagEvaluation.matchedRuleNames,
    };
  }

  return {
    tagOutcome: 'pending',
    pageOutcome: 'pending',
    requiredArtifacts: [],
    reason: tagEvaluation.reason,
    pendingReason: 'rule_unmatched',
    matchedRuleNames: [],
  };
}

export function getDefaultSpikeConfig(seedUrl: string): SiteConfig {
  const url = new URL(seedUrl);
  return {
    seedUrls: [seedUrl],
    sitemaps: [],
    urlRules: [],
    tagRules: [
      {
        name: 'spike-allow-markdown',
        listType: 'whitelist',
        when: [
          {
            key: 'content_type',
            op: 'any_of',
            values: ['docs', 'product', 'generic'],
          },
        ],
        artifacts: ['markdown'],
      },
    ],
    runOptions: {
      previewMaxDepth: 1,
      crawlMaxDepth: url.hostname.endsWith('.local') ? 1 : 2,
    },
  };
}

export function toRuleOutcome(outcome: RuleOutcome): RuleOutcome {
  return outcome;
}
