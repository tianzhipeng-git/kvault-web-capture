export type ArtifactType = 'markdown' | 'screenshot';

export type RuleOutcome = 'allow' | 'deny' | 'pending';

export type UrlRuleDecision = 'allow' | 'deny';

export type RuleMatchType = 'url' | 'tag';

export type RunType = 'seed_run' | 'crawl_run';

export type RunStatus = 'running' | 'succeeded' | 'failed';

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
  tags: Record<string, string[]>;
}

export interface UrlRule {
  name: string;
  matchType: 'url';
  listType: 'blacklist' | 'scopelist' | 'whitelist';
  ruleType: 'prefix' | 'regex';
  values: string[];
  artifacts?: ArtifactType[];
}

export interface TagRuleCondition {
  key: string;
  op: 'any_of' | 'all_of' | 'is_empty';
  values?: string[];
}

export interface TagRule {
  name: string;
  matchType: 'tag';
  listType: 'blacklist' | 'scopelist' | 'whitelist';
  when: TagRuleCondition[];
  artifacts: ArtifactType[];
}

export interface SiteRunOptions {
  seedMaxDepth: number;
  crawlMaxDepth: number;
}

export interface SiteConfig {
  seedUrls: string[];
  sitemaps: string[];
  rulesBeforeBaseEq: UrlRule[];
  rulesBeforeStage2Eq: Array<UrlRule | TagRule>;
  runOptions: SiteRunOptions;
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

export interface BaseRequestUserData {
  stage: 'base';
  runId: number;
  siteId: number;
  sitePageId: number;
  normalizedUrl: string;
  depth: number;
  runType: RunType;
}

export interface MarkdownRequestUserData {
  stage: 'markdown';
  runId: number;
  siteId: number;
  sitePageId: number;
  pageRunId: number;
  normalizedUrl: string;
}

export interface ScreenshotRequestUserData {
  stage: 'screenshot';
  runId: number;
  siteId: number;
  sitePageId: number;
  pageRunId: number;
  normalizedUrl: string;
}

export type CrawlRequestUserData =
  | BaseRequestUserData
  | MarkdownRequestUserData
  | ScreenshotRequestUserData;

export interface StageDecisionSnapshot {
  outcome: RuleOutcome;
  requiredArtifacts: ArtifactType[];
}

export interface PlannedRequest {
  siteId: number;
  sitePageId: number;
  normalizedUrl: string;
  enqueue: boolean;
  urlRuleDecision: UrlRuleDecision;
  skipReason: string | null;
}

export interface HistoricalPageState {
  sitePageId: number;
  normalizedUrl: string;
  inventoryStatus: InventoryStatus;
  lastBaseStatus: BaseCaptureStatus | null;
  lastBaseAt: string | null;
  latestClassificationTags: Record<string, string[]> | null;
  lastStageDecision: StageDecisionSnapshot | null;
  lastMarkdownStatus: ArtifactRunStatus | null;
  lastMarkdownAt: string | null;
  lastScreenshotStatus: ArtifactRunStatus | null;
  lastScreenshotAt: string | null;
}

export interface CrawlRunCreateInput {
  siteId: number;
  runType: RunType;
  updatePolicy: UpdatePolicy;
  targetSuccessCount: number | null;
  configSnapshot: SiteConfig;
}

export interface SpikeRunOptions {
  dbPath: string;
  storageDir: string;
  seedUrl: string;
  siteName?: string;
}

export interface SpikeRunSummary {
  runId: number;
  siteId: number;
  sitePageId: number;
  normalizedUrl: string;
  pageRuns: number;
  artifactRuns: number;
}
