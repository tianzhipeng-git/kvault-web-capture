export type ArtifactType = 'markdown';

export type RuleOutcome = 'allow' | 'deny' | 'pending';

export type RunStatus = 'running' | 'succeeded' | 'failed';

export type PageRunStatus = 'succeeded' | 'failed';

export type ArtifactRunStatus = 'succeeded' | 'failed';

export interface ExtractedPage {
  url: string;
  normalizedUrl: string;
  title: string;
  metaDescription: string;
  bodyText: string;
}

export interface ClassificationResult {
  tags: string[];
}

export interface RuleDecision {
  outcome: RuleOutcome;
  requiredArtifacts: ArtifactType[];
  reason: string | null;
}

export interface BaseRequestUserData {
  stage: 'base';
  runId: number;
  siteId: number;
  sitePageId: number;
  normalizedUrl: string;
}

export interface MarkdownRequestUserData {
  stage: 'markdown';
  runId: number;
  siteId: number;
  sitePageId: number;
  normalizedUrl: string;
}

export type CrawlRequestUserData = BaseRequestUserData | MarkdownRequestUserData;

export interface PlannedRun {
  runId: number;
  siteId: number;
  sitePageId: number;
  normalizedUrl: string;
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
