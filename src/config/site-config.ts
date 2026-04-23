import { readFileSync } from 'node:fs';

import type {
  ArtifactType,
  SiteConfig,
  SiteRunOptions,
  TagRule,
  UrlRule,
} from '../domain/types.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown, fieldName: string): string[] {
  assert(Array.isArray(value), `${fieldName} must be an array`);
  assert(value.every((item) => typeof item === 'string'), `${fieldName} must contain strings`);
  return value;
}

function assertUniqueRuleNames(rules: Array<{ name: string }>, fieldName: string): void {
  const names = new Set<string>();

  for (const rule of rules) {
    assert(!names.has(rule.name), `${fieldName} contains duplicate rule name ${rule.name}`);
    names.add(rule.name);
  }
}

function parseArtifacts(value: unknown, fieldName: string): ArtifactType[] {
  const artifacts = asStringArray(value, fieldName);
  assert(
    artifacts.every((artifact) => artifact === 'markdown' || artifact === 'screenshot'),
    `${fieldName} only supports markdown or screenshot`,
  );
  return artifacts as ArtifactType[];
}

function parseUrlRule(rule: unknown, fieldName: string): UrlRule {
  assert(isRecord(rule), `${fieldName} must be an object`);
  assert(
    rule.matchType === 'url' || rule.matchType === undefined,
    `${fieldName}.matchType must be url`,
  );
  assert(
    rule.listType === 'blacklist' ||
      rule.listType === 'scopelist' ||
      rule.listType === 'whitelist',
    `${fieldName}.listType must be blacklist, scopelist, or whitelist`,
  );
  assert(
    rule.ruleType === 'prefix' || rule.ruleType === 'regex',
    `${fieldName}.ruleType must be prefix or regex`,
  );

  return {
    name: typeof rule.name === 'string' ? rule.name : fieldName,
    matchType: 'url',
    listType: rule.listType,
    ruleType: rule.ruleType,
    values: asStringArray(rule.values, `${fieldName}.values`),
    artifacts:
      rule.artifacts === undefined
        ? undefined
        : parseArtifacts(rule.artifacts, `${fieldName}.artifacts`),
  };
}

function parseTagRule(rule: unknown, fieldName: string): TagRule {
  assert(isRecord(rule), `${fieldName} must be an object`);
  assert(rule.matchType === 'tag', `${fieldName}.matchType must be tag`);
  assert(
    rule.listType === 'blacklist' ||
      rule.listType === 'scopelist' ||
      rule.listType === 'whitelist',
    `${fieldName}.listType must be blacklist, scopelist, or whitelist`,
  );
  assert(Array.isArray(rule.when), `${fieldName}.when must be an array`);

  return {
    name: typeof rule.name === 'string' ? rule.name : fieldName,
    matchType: 'tag',
    listType: rule.listType,
    when: rule.when.map((condition, conditionIndex) => {
      assert(
        isRecord(condition),
        `${fieldName}.when[${conditionIndex}] must be an object`,
      );
      assert(
        typeof condition.key === 'string',
        `${fieldName}.when[${conditionIndex}].key must be a string`,
      );
      assert(
        condition.op === 'any_of' ||
          condition.op === 'all_of' ||
          condition.op === 'is_empty',
        `${fieldName}.when[${conditionIndex}].op must be any_of, all_of, or is_empty`,
      );

      return {
        key: condition.key,
        op: condition.op,
        values:
          condition.op === 'is_empty'
            ? undefined
            : asStringArray(
                condition.values,
                `${fieldName}.when[${conditionIndex}].values`,
              ),
      };
    }),
    artifacts: parseArtifacts(rule.artifacts ?? ['markdown'], `${fieldName}.artifacts`),
  };
}

function parseRulesBeforeBaseEq(value: unknown): UrlRule[] {
  assert(Array.isArray(value), 'rulesBeforeBaseEq must be an array');

  const rules = value.map((rule, index) =>
    parseUrlRule(rule, `rulesBeforeBaseEq[${index}]`),
  );
  assertUniqueRuleNames(rules, 'rulesBeforeBaseEq');
  return rules;
}

function parseRulesBeforeStage2Eq(value: unknown): Array<UrlRule | TagRule> {
  assert(Array.isArray(value), 'rulesBeforeStage2Eq must be an array');

  const rules = value.map((rule, index) => {
    assert(isRecord(rule), `rulesBeforeStage2Eq[${index}] must be an object`);

    if (rule.matchType === 'tag') {
      return parseTagRule(rule, `rulesBeforeStage2Eq[${index}]`);
    }

    return parseUrlRule(rule, `rulesBeforeStage2Eq[${index}]`);
  });

  assertUniqueRuleNames(rules, 'rulesBeforeStage2Eq');
  return rules;
}

function parseRunOptions(value: unknown): SiteRunOptions {
  assert(isRecord(value), 'runOptions must be an object');

  const seedMaxDepth =
    typeof value.seedMaxDepth === 'number' ? value.seedMaxDepth : 1;
  const crawlMaxDepth =
    typeof value.crawlMaxDepth === 'number' ? value.crawlMaxDepth : 2;

  assert(seedMaxDepth >= 0, 'runOptions.seedMaxDepth must be >= 0');
  assert(crawlMaxDepth >= 0, 'runOptions.crawlMaxDepth must be >= 0');

  return {
    seedMaxDepth,
    crawlMaxDepth,
  };
}

export function parseSiteConfig(input: unknown): SiteConfig {
  assert(isRecord(input), 'site config must be an object');

  return {
    seedUrls: asStringArray(input.seedUrls, 'seedUrls'),
    sitemaps: asStringArray(input.sitemaps ?? [], 'sitemaps'),
    rulesBeforeBaseEq: parseRulesBeforeBaseEq(
      input.rulesBeforeBaseEq ?? input.rules_before_base_eq ?? [],
    ),
    rulesBeforeStage2Eq: parseRulesBeforeStage2Eq(
      input.rulesBeforeStage2Eq ?? input.rules_before_stage2_eq ?? [],
    ),
    runOptions: parseRunOptions(input.runOptions ?? {}),
  };
}

export function loadSiteConfig(configPath: string): SiteConfig {
  const content = readFileSync(configPath, 'utf8');
  return parseSiteConfig(JSON.parse(content) as unknown);
}

export function createDefaultSiteConfig(baseUrl: string): SiteConfig {
  return {
    seedUrls: [baseUrl],
    sitemaps: [],
    rulesBeforeBaseEq: [],
    rulesBeforeStage2Eq: [
      {
        name: 'default-markdown',
        matchType: 'tag',
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
      seedMaxDepth: 1,
      crawlMaxDepth: 2,
    },
  };
}
