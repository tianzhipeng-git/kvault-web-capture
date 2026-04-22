export type ArtifactType = 'markdown';

export type RuleOutcome = 'allow' | 'deny' | 'pending';

export type UrlRuleDecision = 'allow' | 'deny';

export type RunType = 'inventory_preview' | 'crawl_run';

export type RunStatus = 'running' | 'succeeded' | 'failed';

export type UpdatePolicy =
  | 'force_recrawl_all'
  | 'skip_existing'
  | 'rerun_failed_artifacts'
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

export type PendingReason = 'classifier_failed' | 'rule_unmatched' | 'preview_run';

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
  listType: 'blacklist' | 'scopelist';
  ruleType: 'prefix' | 'regex';
  values: string[];
}

export interface TagRuleCondition {
  key: string;
  op: 'any_of' | 'all_of' | 'is_empty';
  values?: string[];
}

export interface TagRule {
  name: string;
  listType: 'blacklist' | 'whitelist';
  when: TagRuleCondition[];
  artifacts: ArtifactType[];
}

export interface SiteRunOptions {
  previewMaxDepth: number;
  crawlMaxDepth: number;
}

export interface SiteConfig {
  seedUrls: string[];
  sitemaps: string[];
  urlRules: UrlRule[];
  tagRules: TagRule[];
  runOptions: SiteRunOptions;
}

export interface UrlRuleEvaluation {
  outcome: UrlRuleDecision;
  matchedRuleName: string | null;
  reason: string | null;
}

export interface TagRuleEvaluation {
  outcome: RuleOutcome;
  matchedRuleNames: string[];
  requiredArtifacts: ArtifactType[];
  reason: string | null;
}

export interface StageDecision {
  tagOutcome: RuleOutcome;
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

export type CrawlRequestUserData = BaseRequestUserData | MarkdownRequestUserData;

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
  lastTagRuleDecision: RuleOutcome | null;
  lastMarkdownStatus: ArtifactRunStatus | null;
  lastMarkdownAt: string | null;
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
