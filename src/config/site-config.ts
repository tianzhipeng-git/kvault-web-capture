import { readFileSync } from 'node:fs';

import type {
  ArtifactType,
  BrowserConfig,
  CaptureProfileConfig,
  CaptureValidationConfig,
  CaptureValidationRule,
  LabelRule,
  ProxyPolicyConfig,
  ScreenshotConfig,
  ScreenshotPreparationConfig,
  ScreenshotVariantConfig,
  SiteConfig,
  SiteRunOptions,
  UrlNormalizationConfig,
  UrlRule,
} from '../domain/types.js';
import { DEFAULT_SCREENSHOT_PREPARATION } from '../domain/artifact-requirements.js';
import { devices } from 'playwright';

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
  const maxRequestRetries =
    typeof value.maxRequestRetries === 'number' ? value.maxRequestRetries : 3;

  assert(seedMaxDepth >= 0, 'runOptions.seedMaxDepth must be >= 0');
  assert(crawlMaxDepth >= 0, 'runOptions.crawlMaxDepth must be >= 0');
  assert(maxRequestRetries >= 0, 'runOptions.maxRequestRetries must be >= 0');

  return {
    seedMaxDepth,
    crawlMaxDepth,
    maxRequestRetries,
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
  const cdpPoolSize = value.cdpPoolSize;

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
  assert(
    cdpPoolSize === undefined || (
      typeof cdpPoolSize === 'number' &&
      Number.isInteger(cdpPoolSize) &&
      cdpPoolSize >= 1 &&
      cdpPoolSize <= 4
    ),
    'browser.cdpPoolSize must be an integer between 1 and 4',
  );

  return {
    engine,
    profileMode,
    ...(typeof cdpPoolSize === 'number' ? { cdpPoolSize } : {}),
    reuse,
    contextReuse,
    pageReuse,
    proxyBinding,
  };
}

function boundedNumber(
  value: unknown,
  fallback: number,
  fieldName: string,
  min: number,
  max: number,
): number {
  const resolved = value ?? fallback;
  assert(
    typeof resolved === 'number' && Number.isFinite(resolved) && resolved >= min && resolved <= max,
    `${fieldName} must be between ${min} and ${max}`,
  );
  return resolved;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  fieldName: string,
  min: number,
  max: number,
): number {
  const resolved = boundedNumber(value, fallback, fieldName, min, max);
  assert(Number.isInteger(resolved), `${fieldName} must be an integer`);
  return resolved;
}

function parseScreenshotPreparation(
  value: unknown,
  fieldName: string,
): ScreenshotPreparationConfig {
  const input = value ?? {};
  assert(isRecord(input), `${fieldName} must be an object`);
  const booleanValue = (
    key: keyof ScreenshotPreparationConfig,
  ): boolean => {
    const resolved = input[key] ?? DEFAULT_SCREENSHOT_PREPARATION[key];
    assert(typeof resolved === 'boolean', `${fieldName}.${key} must be a boolean`);
    return resolved;
  };
  const onLimit = input.onLimit ?? DEFAULT_SCREENSHOT_PREPARATION.onLimit;
  assert(onLimit === 'truncate' || onLimit === 'fail', `${fieldName}.onLimit must be truncate or fail`);
  const dismissSelectors = asStringArray(
    input.dismissSelectors ?? DEFAULT_SCREENSHOT_PREPARATION.dismissSelectors,
    `${fieldName}.dismissSelectors`,
  );
  assert(
    dismissSelectors.length <= 20 && dismissSelectors.every((selector) => selector.length > 0 && selector.length <= 500),
    `${fieldName}.dismissSelectors must contain at most 20 non-empty selectors of at most 500 characters`,
  );

  return {
    dismissSelectors,
    waitForImages: booleanValue('waitForImages'),
    waitForFonts: booleanValue('waitForFonts'),
    scrollDocument: booleanValue('scrollDocument'),
    scrollContainers: booleanValue('scrollContainers'),
    expandScrollContainers: booleanValue('expandScrollContainers'),
    scrollStepRatio: boundedNumber(input.scrollStepRatio, 0.8, `${fieldName}.scrollStepRatio`, 0.1, 1),
    settleMs: boundedInteger(input.settleMs, 500, `${fieldName}.settleMs`, 0, 10_000),
    stableRounds: boundedInteger(input.stableRounds, 2, `${fieldName}.stableRounds`, 1, 20),
    maxScrollRounds: boundedInteger(input.maxScrollRounds, 100, `${fieldName}.maxScrollRounds`, 1, 1_000),
    maxCaptureHeight: boundedInteger(input.maxCaptureHeight, 50_000, `${fieldName}.maxCaptureHeight`, 1_000, 200_000),
    timeoutMs: boundedInteger(input.timeoutMs, 90_000, `${fieldName}.timeoutMs`, 1_000, 170_000),
    onLimit,
  };
}

function parseScreenshotVariant(value: unknown, fieldName: string): ScreenshotVariantConfig {
  assert(isRecord(value), `${fieldName} must be an object`);
  assert(
    typeof value.key === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value.key),
    `${fieldName}.key must match ^[a-z0-9][a-z0-9-]{0,63}$`,
  );
  assert(typeof value.device === 'string', `${fieldName}.device must be a string`);

  if (value.device === 'desktop') {
    assert(isRecord(value.viewport), `${fieldName}.viewport must be an object`);
    const width = boundedInteger(value.viewport.width, 0, `${fieldName}.viewport.width`, 320, 7_680);
    const height = boundedInteger(value.viewport.height, 0, `${fieldName}.viewport.height`, 320, 4_320);
    const deviceScaleFactor = boundedNumber(
      value.deviceScaleFactor,
      1,
      `${fieldName}.deviceScaleFactor`,
      1,
      4,
    );
    return { key: value.key, device: 'desktop', viewport: { width, height }, deviceScaleFactor };
  }

  assert(value.device in devices, `${fieldName}.device is not a supported Playwright device`);
  return { key: value.key, device: value.device };
}

function parseScreenshotConfig(value: unknown): ScreenshotConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  assert(isRecord(value), 'screenshot must be an object');
  const mode = value.mode ?? 'basic';
  assert(mode === 'basic' || mode === 'complete', 'screenshot.mode must be basic or complete');
  if (mode === 'basic') {
    return { mode };
  }

  assert(Array.isArray(value.variants), 'screenshot.variants must be an array in complete mode');
  assert(value.variants.length >= 1 && value.variants.length <= 10, 'screenshot.variants must contain 1 to 10 variants');
  const variants = value.variants.map((variant, index) =>
    parseScreenshotVariant(variant, `screenshot.variants[${index}]`),
  );
  const keys = variants.map((variant) => variant.key);
  assert(new Set(keys).size === keys.length, 'screenshot.variants contains duplicate keys');
  return {
    mode,
    preparation: parseScreenshotPreparation(value.preparation, 'screenshot.preparation'),
    variants,
  };
}

export function parseSiteConfig(input: unknown): SiteConfig {
  assert(isRecord(input), 'site config must be an object');

  const captureProfile = parseCaptureProfileConfig(input.captureProfile);
  const proxyPolicy = parseProxyPolicy(input.proxyPolicy);
  const browser = parseBrowserConfig(input.browser);
  const urlNormalization = parseUrlNormalization(input.urlNormalization);
  const screenshot = parseScreenshotConfig(input.screenshot);

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
  if (screenshot !== undefined) {
    config.screenshot = screenshot;
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
      maxRequestRetries: 3,
    },
  };
}
