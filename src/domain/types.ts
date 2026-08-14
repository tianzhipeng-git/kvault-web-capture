export type ArtifactType = 'markdown' | 'screenshot' | 'structured';

export type CaptureCapability = 'base' | ArtifactType;

export interface ArtifactRequirement {
  artifactType: ArtifactType;
  variantKey: string;
  configFingerprint: string | null;
}

export type ScreenshotMode = 'basic' | 'complete';

export interface ScreenshotPreparationConfig {
  waitForImages: boolean;
  waitForFonts: boolean;
  scrollDocument: boolean;
  scrollContainers: boolean;
  expandScrollContainers: boolean;
  scrollStepRatio: number;
  settleMs: number;
  stableRounds: number;
  maxScrollRounds: number;
  maxCaptureHeight: number;
  timeoutMs: number;
  onLimit: 'truncate' | 'fail';
}

export type ScreenshotVariantConfig =
  | {
      key: string;
      device: 'desktop';
      viewport: { width: number; height: number };
      deviceScaleFactor: number;
    }
  | {
      key: string;
      device: string;
    };

export interface ScreenshotConfig {
  mode: ScreenshotMode;
  preparation?: ScreenshotPreparationConfig;
  variants?: ScreenshotVariantConfig[];
}

export interface ScreenshotMetadata {
  protocolVersion: 1;
  mode: ScreenshotMode;
  variantKey: string;
  configFingerprint: string;
  device: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  documentScrollCompleted: boolean;
  scrollContainersFound: number;
  scrollContainersCompleted: number;
  scrollContainersExpanded: number;
  imagesFound: number;
  imagesPending: number;
  fontsReady: boolean;
  truncated: boolean;
  limitReason: string | null;
  preparationDurationMs: number;
  captureWidth: number | null;
  captureHeight: number | null;
  warnings: string[];
}

export type RuleOutcome = 'allow' | 'deny' | 'pending';

export type UrlRuleDecision = 'allow' | 'deny';

export type RuleMatchType = 'url' | 'label';

export type RunType = 'seed_run' | 'crawl_run';

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export type UpdatePolicy =
  | 'force_recrawl_all'
  | 'skip_existing'
  | 'stale_after_duration';

export type BaseCaptureStatus = 'succeeded' | 'failed';

export type ArtifactRunStatus = 'succeeded' | 'failed';

export type InventoryStatus =
  | 'discovered_only'
  | 'url_rule_denied'
  | 'base_captured'
  | 'stage2_pending'
  | 'stage2_skipped'
  | 'stage2_captured';

export type PendingReason = 'classifier_failed' | 'rule_unmatched' | 'seed_run';

export interface ExtractedPage {
  url: string;
  normalizedUrl: string;
  title: string;
  metaDescription: string;
  bodyText: string;
  links: string[];
}

export interface ClassificationResult {
  labels: Record<string, string[]>;
}

export interface UrlRule {
  name: string;
  matchType: 'url';
  listType: 'blacklist' | 'scopelist' | 'whitelist';
  ruleType: 'prefix' | 'regex';
  values: string[];
  artifacts?: ArtifactType[];
}

export interface LabelRuleCondition {
  key: string;
  op: 'any_of' | 'all_of' | 'is_empty';
  values?: string[];
}

export interface LabelRule {
  name: string;
  matchType: 'label';
  listType: 'blacklist' | 'scopelist' | 'whitelist';
  when: LabelRuleCondition[];
  artifacts: ArtifactType[];
}

export interface SiteRunOptions {
  seedMaxDepth: number;
  crawlMaxDepth: number;
  maxRequestRetries: number;
}

export interface UrlNormalizationConfig {
  stripQueryParams: string[];
  stripQueryParamPrefixes?: string[];
}

export interface SystemConfig {
  urlNormalization: UrlNormalizationConfig;
}

export interface CaptureValidationRule {
  minLength?: number;
  minBytes?: number;
  rejectRegex?: string[];
  requireRegex?: string[];
}

export interface CaptureValidationConfig {
  base?: CaptureValidationRule;
  markdown?: CaptureValidationRule;
  screenshot?: CaptureValidationRule;
  structured?: CaptureValidationRule;
}

export interface CaptureProfileConfig {
  tools: string[];
}

export interface ProxyPolicyConfig {
  mode: 'off' | 'always' | 'retry_on_failure';
  provider?: 'crawlee' | 'apify';
}

export type BrowserEngine = 'chromium' | 'cloakbrowser' | 'lightpanda';

export type BrowserProfileMode = 'ephemeral' | 'persistent' | 'storage_state';

export interface BrowserConfig {
  engine: BrowserEngine;
  profileMode: BrowserProfileMode;
  cdpPoolSize?: number;
  reuse?: 'run_browser' | 'site_browser';
  contextReuse?: 'site_session_proxy' | 'site_run';
  pageReuse?: 'none';
  proxyBinding?: 'session' | 'none';
}

export interface SiteConfig {
  seedUrls: string[];
  sitemaps: string[];
  rulesBeforeBaseEq: UrlRule[];
  rulesBeforeStage2Eq: Array<UrlRule | LabelRule>;
  runOptions: SiteRunOptions;
  urlNormalization?: UrlNormalizationConfig;
  captureProfile?: CaptureProfileConfig;
  validation?: CaptureValidationConfig;
  proxyPolicy?: ProxyPolicyConfig;
  browser?: BrowserConfig;
  screenshot?: ScreenshotConfig;
}

export interface RuleEvaluation {
  outcome: RuleOutcome;
  matchedRuleNames: string[];
  requiredArtifacts: ArtifactType[];
  reason: string | null;
}

export interface StageDecision {
  ruleOutcome: RuleOutcome;
  pageOutcome: RuleOutcome;
  requiredArtifacts: ArtifactType[];
  reason: string | null;
  pendingReason: PendingReason | null;
  matchedRuleNames: string[];
}

export interface PageCaptureTask {
  stage: 'page_capture';
  runId: number;
  siteId: number;
  sitePageId: number;
  normalizedUrl: string;
  url: string;
  depth: number;
  needs: CaptureCapability[];
  pageRunId?: number;
  purpose?: 'discovery' | 'artifact' | 'refresh';
  artifactRequirement?: ArtifactRequirement;
}

export type CrawlRequestUserData = PageCaptureTask;

export interface StageDecisionSnapshot {
  outcome: RuleOutcome;
  requiredArtifacts: ArtifactRequirement[];
}

export interface PlannedRequest {
  siteId: number;
  sitePageId: number;
  normalizedUrl: string;
  enqueue: boolean;
  urlRuleDecision: UrlRuleDecision;
  planReason: string | null;
}

export interface HistoricalPageState {
  sitePageId: number;
  normalizedUrl: string;
  inventoryStatus: InventoryStatus;
  lastBaseStatus: BaseCaptureStatus | null;
  lastBaseAt: string | null;
  latestClassificationLabels: Record<string, string[]> | null;
  lastStageDecision: StageDecisionSnapshot | null;
  lastMarkdownStatus: ArtifactRunStatus | null;
  lastMarkdownAt: string | null;
  lastScreenshotStatus: ArtifactRunStatus | null;
  lastScreenshotAt: string | null;
  lastStructuredStatus: ArtifactRunStatus | null;
  lastStructuredAt: string | null;
}

export interface CrawlRunCreateInput {
  siteId: number;
  runType: RunType;
  updatePolicy: UpdatePolicy;
  targetSuccessCount: number | null;
  staleAfterMs: number | null;
  configSnapshot: SiteConfig;
}

export interface RunSummary {
  runId: number;
  siteId: number;
  sitePageId: number;
  normalizedUrl: string;
  pageRuns: number;
  artifactRuns: number;
}
