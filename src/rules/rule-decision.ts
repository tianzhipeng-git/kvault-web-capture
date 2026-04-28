import type {
  ArtifactType,
  ClassificationResult,
  LabelRule,
  LabelRuleCondition,
  RuleEvaluation,
  RunType,
  SiteConfig,
  StageDecision,
  UrlRule,
  UrlRuleDecision,
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

function matchesCondition(classification: ClassificationResult, condition: LabelRuleCondition): boolean {
  const values = classification.labels[condition.key] ?? [];

  if (condition.op === 'is_empty') {
    return values.length === 0;
  }

  const requiredValues = condition.values ?? [];

  if (condition.op === 'any_of') {
    return requiredValues.some((value) => values.includes(value));
  }

  return requiredValues.every((value) => values.includes(value));
}

function matchesLabelRule(classification: ClassificationResult, rule: LabelRule): boolean {
  return rule.when.every((condition) => matchesCondition(classification, condition));
}

export function evaluateUrlRules(url: string, rules: UrlRule[]): RuleEvaluation {
  const matchedBlacklists = rules.filter(
    (rule) => rule.listType === 'blacklist' && matchesUrlRule(url, rule),
  );

  if (matchedBlacklists.length > 0) {
    return {
      outcome: 'deny',
      matchedRuleNames: matchedBlacklists.map((rule) => rule.name),
      requiredArtifacts: [],
      reason: `matched blacklist rule ${matchedBlacklists[0]!.name}`,
    };
  }

  const scopelists = rules.filter((rule) => rule.listType === 'scopelist');
  const failedScopelist = scopelists.find((rule) => !matchesUrlRule(url, rule));

  if (failedScopelist) {
    return {
      outcome: 'deny',
      matchedRuleNames: [],
      requiredArtifacts: [],
      reason: `outside scopelist rule ${failedScopelist.name}`,
    };
  }

  const matchedWhitelists = rules.filter(
    (rule) => rule.listType === 'whitelist' && matchesUrlRule(url, rule),
  );

  if (matchedWhitelists.length > 0) {
    return {
      outcome: 'allow',
      matchedRuleNames: uniqueSorted([
        ...scopelists.map((rule) => rule.name),
        ...matchedWhitelists.map((rule) => rule.name),
      ]),
      requiredArtifacts: uniqueSorted(
        matchedWhitelists.flatMap((rule) => rule.artifacts ?? []),
      ),
      reason: null,
    };
  }

  return {
    outcome: 'allow',
    matchedRuleNames: scopelists.map((rule) => rule.name),
    requiredArtifacts: uniqueSorted(
      scopelists.flatMap((rule) => rule.artifacts ?? []),
    ),
    reason: null,
  };
}

export function evaluateLabelRules(
  classification: ClassificationResult,
  rules: LabelRule[],
): RuleEvaluation {
  const matchedBlacklists = rules.filter(
    (rule) => rule.listType === 'blacklist' && matchesLabelRule(classification, rule),
  );

  if (matchedBlacklists.length > 0) {
    return {
      outcome: 'deny',
      matchedRuleNames: matchedBlacklists.map((rule) => rule.name),
      requiredArtifacts: [],
      reason: `matched blacklist rule ${matchedBlacklists[0]!.name}`,
    };
  }

  const scopelists = rules.filter((rule) => rule.listType === 'scopelist');
  const failedScopelist = scopelists.find(
    (rule) => !matchesLabelRule(classification, rule),
  );

  if (failedScopelist) {
    return {
      outcome: 'deny',
      matchedRuleNames: [],
      requiredArtifacts: [],
      reason: `outside scopelist rule ${failedScopelist.name}`,
    };
  }

  const matchedWhitelists = rules.filter(
    (rule) => rule.listType === 'whitelist' && matchesLabelRule(classification, rule),
  );

  if (matchedWhitelists.length === 0) {
    return {
      outcome: 'pending',
      matchedRuleNames: scopelists.map((rule) => rule.name),
      requiredArtifacts: [],
      reason: 'no label rule matched',
    };
  }

  return {
    outcome: 'allow',
    matchedRuleNames: uniqueSorted([
      ...scopelists.map((rule) => rule.name),
      ...matchedWhitelists.map((rule) => rule.name),
    ]),
    requiredArtifacts: uniqueSorted(
      matchedWhitelists.flatMap((rule) => rule.artifacts),
    ),
    reason: null,
  };
}

function evaluateExecutionPoint(input: {
  url: string;
  classification: ClassificationResult | null;
  urlRules: UrlRule[];
  labelRules: LabelRule[];
  defaultOutcome: 'allow' | 'pending';
}): RuleEvaluation {
  const urlEvaluation = evaluateUrlRules(input.url, input.urlRules);

  if (urlEvaluation.outcome === 'deny') {
    return urlEvaluation;
  }

  const labelEvaluation =
    input.classification === null
      ? null
      : evaluateLabelRules(input.classification, input.labelRules);

  if (labelEvaluation?.outcome === 'deny') {
    return labelEvaluation;
  }

  const combinedArtifacts = uniqueSorted([
    ...urlEvaluation.requiredArtifacts,
    ...(labelEvaluation?.outcome === 'allow' ? labelEvaluation.requiredArtifacts : []),
  ]);
  const combinedMatchedRuleNames = uniqueSorted([
    ...urlEvaluation.matchedRuleNames,
    ...(labelEvaluation?.outcome === 'allow' ? labelEvaluation.matchedRuleNames : []),
  ]);

  if (combinedArtifacts.length > 0) {
    return {
      outcome: 'allow',
      matchedRuleNames: combinedMatchedRuleNames,
      requiredArtifacts: combinedArtifacts,
      reason: null,
    };
  }

  return {
    outcome: input.defaultOutcome,
    matchedRuleNames: input.defaultOutcome === 'allow' ? urlEvaluation.matchedRuleNames : [],
    requiredArtifacts: [],
    reason: input.defaultOutcome === 'pending' ? 'no whitelist rule matched' : null,
  };
}

export function buildBaseEnqueueDecision(input: {
  url: string;
  siteConfig: SiteConfig;
}): {
  enqueue: boolean;
  urlRuleDecision: UrlRuleDecision;
  reason: string | null;
  matchedRuleNames: string[];
} {
  const evaluation = evaluateExecutionPoint({
    url: input.url,
    classification: null,
    urlRules: input.siteConfig.rulesBeforeBaseEq,
    labelRules: [],
    defaultOutcome: 'allow',
  });

  return {
    enqueue: evaluation.outcome === 'allow',
    urlRuleDecision: evaluation.outcome === 'deny' ? 'deny' : 'allow',
    reason: evaluation.outcome === 'deny' ? evaluation.reason : null,
    matchedRuleNames: evaluation.matchedRuleNames,
  };
}

function applySeedRunPending(decision: StageDecision): StageDecision {
  if (decision.pageOutcome !== 'allow') {
    return decision;
  }

  return {
    ...decision,
    pageOutcome: 'pending',
    pendingReason: 'seed_run',
  };
}

export function buildStage2EnqueueDecision(input: {
  runType: RunType;
  url: string;
  siteConfig: SiteConfig;
  classification: ClassificationResult | null;
  classificationError?: Error | null;
}): StageDecision {
  if (input.classificationError || input.classification === null) {
    return {
      ruleOutcome: 'pending',
      pageOutcome: 'pending',
      requiredArtifacts: [],
      reason: input.classificationError?.message ?? 'classifier failed',
      pendingReason: 'classifier_failed',
      matchedRuleNames: [],
    };
  }

  const rulesBeforeStage2Eq = input.siteConfig.rulesBeforeStage2Eq;
  const evaluation = evaluateExecutionPoint({
    url: input.url,
    classification: input.classification,
    urlRules: rulesBeforeStage2Eq.filter((rule) => rule.matchType === 'url'),
    labelRules: rulesBeforeStage2Eq.filter((rule) => rule.matchType === 'label'),
    defaultOutcome: 'pending',
  });

  const decision: StageDecision =
    evaluation.outcome === 'deny'
      ? {
        ruleOutcome: 'deny',
        pageOutcome: 'deny',
        requiredArtifacts: [],
        reason: evaluation.reason,
        pendingReason: null,
        matchedRuleNames: evaluation.matchedRuleNames,
      }
      : evaluation.outcome === 'allow'
        ? {
          ruleOutcome: 'allow',
          pageOutcome: 'allow',
          requiredArtifacts: evaluation.requiredArtifacts,
          reason: null,
          pendingReason: null,
          matchedRuleNames: evaluation.matchedRuleNames,
        }
        : {
          ruleOutcome: 'pending',
          pageOutcome: 'pending',
          requiredArtifacts: [],
          reason: evaluation.reason,
          pendingReason: 'rule_unmatched',
          matchedRuleNames: [],
        };

  return input.runType === 'seed_run' ? applySeedRunPending(decision) : decision;
}
