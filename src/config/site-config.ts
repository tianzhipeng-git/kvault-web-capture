import { readFileSync } from 'node:fs';

import type { ArtifactType, SiteConfig, SiteRunOptions, TagRule, UrlRule } from '../domain/types.js';

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

function parseUrlRules(value: unknown): UrlRule[] {
  assert(Array.isArray(value), 'urlRules must be an array');

  return value.map((rule, index) => {
    assert(isRecord(rule), `urlRules[${index}] must be an object`);
    assert(rule.listType === 'blacklist' || rule.listType === 'scopelist', `urlRules[${index}].listType must be blacklist or scopelist`);
    assert(rule.ruleType === 'prefix' || rule.ruleType === 'regex', `urlRules[${index}].ruleType must be prefix or regex`);

    return {
      name: typeof rule.name === 'string' ? rule.name : `url-rule-${index + 1}`,
      listType: rule.listType,
      ruleType: rule.ruleType,
      values: asStringArray(rule.values, `urlRules[${index}].values`),
    };
  });
}

function parseArtifacts(value: unknown, fieldName: string): ArtifactType[] {
  const artifacts = asStringArray(value, fieldName);
  assert(
    artifacts.every((artifact) => artifact === 'markdown'),
    `${fieldName} only supports markdown in Phase 1-3`,
  );
  return artifacts as ArtifactType[];
}

function parseTagRules(value: unknown): TagRule[] {
  assert(Array.isArray(value), 'tagRules must be an array');

  return value.map((rule, index) => {
    assert(isRecord(rule), `tagRules[${index}] must be an object`);
    assert(rule.listType === 'blacklist' || rule.listType === 'whitelist', `tagRules[${index}].listType must be blacklist or whitelist`);
    assert(Array.isArray(rule.when), `tagRules[${index}].when must be an array`);

    return {
      name: typeof rule.name === 'string' ? rule.name : `tag-rule-${index + 1}`,
      listType: rule.listType,
      when: rule.when.map((condition, conditionIndex) => {
        assert(
          isRecord(condition),
          `tagRules[${index}].when[${conditionIndex}] must be an object`,
        );
        assert(typeof condition.key === 'string', `tagRules[${index}].when[${conditionIndex}].key must be a string`);
        assert(
          condition.op === 'any_of' ||
            condition.op === 'all_of' ||
            condition.op === 'is_empty',
          `tagRules[${index}].when[${conditionIndex}].op must be any_of, all_of, or is_empty`,
        );

        return {
          key: condition.key,
          op: condition.op,
          values:
            condition.op === 'is_empty'
              ? undefined
              : asStringArray(
                  condition.values,
                  `tagRules[${index}].when[${conditionIndex}].values`,
                ),
        };
      }),
      artifacts: parseArtifacts(rule.artifacts ?? ['markdown'], `tagRules[${index}].artifacts`),
    };
  });
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
    urlRules: parseUrlRules(input.urlRules ?? []),
    tagRules: parseTagRules(input.tagRules ?? []),
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
    urlRules: [],
    tagRules: [
      {
        name: 'default-markdown',
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
