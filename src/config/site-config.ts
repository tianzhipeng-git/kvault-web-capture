import { readFileSync } from 'node:fs';

import type {
  ArtifactType,
  BrowserConfig,
  CaptureProfileConfig,
  CaptureValidationConfig,
  CaptureValidationRule,
  LabelRule,
  ProxyPolicyConfig,
  SiteConfig,
  SiteRunOptions,
  UrlNormalizationConfig,
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
    artifacts.every((artifact) => artifact === 'markdown' || artifact === 'screenshot' || artifact === 'structured'),
    `${fieldName} only supports markdown, screenshot, or structured`,
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

function parseLabelRule(rule: unknown, fieldName: string): LabelRule {
  assert(isRecord(rule), `${fieldName} must be an object`);
  assert(rule.matchType === 'label', `${fieldName}.matchType must be label`);
  assert(
    rule.listType === 'blacklist' ||
      rule.listType === 'scopelist' ||
      rule.listType === 'whitelist',
    `${fieldName}.listType must be blacklist, scopelist, or whitelist`,
  );
  assert(Array.isArray(rule.when), `${fieldName}.when must be an array`);

  return {
    name: typeof rule.name === 'string' ? rule.name : fieldName,
    matchType: 'label',
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

function parseRulesBeforeStage2Eq(value: unknown): Array<UrlRule | LabelRule> {
  assert(Array.isArray(value), 'rulesBeforeStage2Eq must be an array');

  const rules = value.map((rule, index) => {
    assert(isRecord(rule), `rulesBeforeStage2Eq[${index}] must be an object`);

    if (rule.matchType === 'label') {
      return parseLabelRule(rule, `rulesBeforeStage2Eq[${index}]`);
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

function parseUrlNormalization(value: unknown): UrlNormalizationConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  assert(isRecord(value), 'urlNormalization must be an object');
  const stripQueryParams = asStringArray(
    value.stripQueryParams ?? [],
    'urlNormalization.stripQueryParams',
  );
  const stripQueryParamPrefixes = asStringArray(
    value.stripQueryParamPrefixes ?? [],
    'urlNormalization.stripQueryParamPrefixes',
  );
  assert(
    stripQueryParams.every((param) => param.length > 0),
    'urlNormalization.stripQueryParams must not contain empty strings',
  );
  assert(
    stripQueryParamPrefixes.every((prefix) => prefix.length > 0),
    'urlNormalization.stripQueryParamPrefixes must not contain empty strings',
  );

  const config: UrlNormalizationConfig = {
    stripQueryParams,
  };
  if (stripQueryParamPrefixes.length > 0) {
    config.stripQueryParamPrefixes = stripQueryParamPrefixes;
  }
  return config;
}

function parseOptionalRegexList(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const values = asStringArray(value, fieldName);
  for (const item of values) {
    assert(item.length > 0, `${fieldName} must not contain empty patterns`);
    try {
      new RegExp(item);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${fieldName} contains invalid regex ${JSON.stringify(item)}: ${message}`);
    }
  }
  return values;
}

function parseValidationRule(value: unknown, fieldName: string): CaptureValidationRule {
  assert(isRecord(value), `${fieldName} must be an object`);

  const minLength = value.minLength;
  const minBytes = value.minBytes;

  assert(
    minLength === undefined || (typeof minLength === 'number' && minLength >= 0),
    `${fieldName}.minLength must be a non-negative number`,
  );
  assert(
    minBytes === undefined || (typeof minBytes === 'number' && minBytes >= 0),
    `${fieldName}.minBytes must be a non-negative number`,
  );

  return {
    minLength,
    minBytes,
    rejectRegex: parseOptionalRegexList(value.rejectRegex, `${fieldName}.rejectRegex`),
    requireRegex: parseOptionalRegexList(value.requireRegex, `${fieldName}.requireRegex`),
  };
}

function parseValidationConfig(value: unknown, fieldName: string): CaptureValidationConfig {
  assert(isRecord(value), `${fieldName} must be an object`);

  return {
    base: value.base === undefined
      ? undefined
      : parseValidationRule(value.base, `${fieldName}.base`),
    markdown: value.markdown === undefined
      ? undefined
      : parseValidationRule(value.markdown, `${fieldName}.markdown`),
    screenshot: value.screenshot === undefined
      ? undefined
      : parseValidationRule(value.screenshot, `${fieldName}.screenshot`),
    structured: value.structured === undefined
      ? undefined
      : parseValidationRule(value.structured, `${fieldName}.structured`),
  };
}

function parseCaptureProfile(value: unknown, fieldName: string): CaptureProfileConfig {
  assert(isRecord(value), `${fieldName} must be an object`);
  return {
    tools: asStringArray(value.tools, `${fieldName}.tools`),
  };
}

function parseCaptureProfileConfig(value: unknown): CaptureProfileConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  return parseCaptureProfile(value, 'captureProfile');
}

function parseProxyPolicy(value: unknown): ProxyPolicyConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  assert(isRecord(value), 'proxyPolicy must be an object');
  assert(
    value.mode === 'off' || value.mode === 'always' || value.mode === 'retry_on_failure',
    'proxyPolicy.mode must be off, always, or retry_on_failure',
  );
  assert(
    value.provider === undefined || value.provider === 'crawlee' || value.provider === 'apify',
    'proxyPolicy.provider must be crawlee or apify',
  );

  return {
    mode: value.mode,
    provider: value.provider,
  };
}

function parseBrowserConfig(value: unknown): BrowserConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  assert(isRecord(value), 'browser must be an object');
  const engine = value.engine ?? 'chromium';
  const profileMode = value.profileMode ?? 'ephemeral';
  const reuse = value.reuse ?? 'run_browser';
  const contextReuse = value.contextReuse ?? 'site_session_proxy';
  const pageReuse = value.pageReuse ?? 'none';
  const proxyBinding = value.proxyBinding ?? 'session';

  assert(
    engine === 'chromium' || engine === 'cloakbrowser' || engine === 'lightpanda',
    'browser.engine must be chromium, cloakbrowser, or lightpanda',
  );
  assert(
    profileMode === 'ephemeral' || profileMode === 'persistent' || profileMode === 'storage_state',
    'browser.profileMode must be ephemeral, persistent, or storage_state',
  );
  assert(
    reuse === 'run_browser' || reuse === 'site_browser',
    'browser.reuse must be run_browser or site_browser',
  );
  assert(
    contextReuse === 'site_session_proxy' || contextReuse === 'site_run',
    'browser.contextReuse must be site_session_proxy or site_run',
  );
  assert(pageReuse === 'none', 'browser.pageReuse currently only supports none');
  assert(
    proxyBinding === 'session' || proxyBinding === 'none',
    'browser.proxyBinding must be session or none',
  );

  return {
    engine,
    profileMode,
    reuse,
    contextReuse,
    pageReuse,
    proxyBinding,
  };
}

export function parseSiteConfig(input: unknown): SiteConfig {
  assert(isRecord(input), 'site config must be an object');

  const captureProfile = parseCaptureProfileConfig(input.captureProfile);
  const proxyPolicy = parseProxyPolicy(input.proxyPolicy);
  const browser = parseBrowserConfig(input.browser);
  const urlNormalization = parseUrlNormalization(input.urlNormalization);

  const config: SiteConfig = {
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

  if (captureProfile !== undefined) {
    config.captureProfile = captureProfile;
  }
  if (urlNormalization !== undefined) {
    config.urlNormalization = urlNormalization;
  }
  if (input.validation !== undefined) {
    config.validation = parseValidationConfig(input.validation, 'validation');
  }
  if (proxyPolicy !== undefined) {
    config.proxyPolicy = proxyPolicy;
  }
  if (browser !== undefined) {
    config.browser = browser;
  }

  return config;
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
        matchType: 'label',
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
