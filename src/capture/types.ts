import type {
  ArtifactRequirement,
  CaptureCapability,
  ExtractedPage,
  ScreenshotMetadata,
  SiteConfig,
} from '../domain/types.js';

export type SendRequestLike = (url: string, options?: Record<string, unknown>) => Promise<unknown>;

export interface RuntimeContext {
  requestId: string;
  sendRequest: SendRequestLike;
  session?: unknown;
  proxyInfo?: {
    url?: string;
    hostname?: string;
    port?: number;
  };
  abortSignal?: AbortSignal;
}

export interface CaptureInput {
  runId: number;
  siteId: number;
  url: string;
  normalizedUrl: string;
  needs: CaptureCapability[];
  siteConfig: SiteConfig;
  runtime: RuntimeContext;
  artifactRequirement?: ArtifactRequirement;
}

export interface CaptureToolResult {
  toolName: string;
  finalUrl?: string;
  statusCode?: number;
  html?: string;
  extracted?: ExtractedPage;
  markdown?: string;
  markdownToolName?: string;
  screenshot?: Buffer;
  screenshotExtension?: 'png';
  screenshotMetadata?: ScreenshotMetadata;
  structured?: unknown;
  diagnostics?: Record<string, unknown>;
}

export interface CaptureDiagnostic {
  toolName: string;
  status: 'succeeded' | 'failed' | 'skipped';
  capabilities: CaptureCapability[];
  message?: string;
}

export interface CaptureResult {
  url: string;
  finalUrl?: string;
  statusCode?: number;
  html?: string;
  extracted?: ExtractedPage;
  markdown?: {
    content: string;
    toolName: string;
  };
  screenshot?: {
    data: Buffer;
    extension: 'png';
    toolName: string;
    metadata?: ScreenshotMetadata;
  };
  structured?: unknown;
  diagnostics: CaptureDiagnostic[];
}

export interface CaptureTool {
  readonly name: string;
  readonly capabilities: readonly CaptureCapability[];
  supports?(capability: CaptureCapability, input: CaptureInput): { supported: boolean; reason?: string };
  capture(input: CaptureInput): Promise<CaptureToolResult>;
}

export interface SiteAutomationAdapter extends CaptureTool {
  readonly siteKey: string;
  matches(input: CaptureInput): boolean;
}

export function isSiteAutomationAdapter(tool: CaptureTool): tool is SiteAutomationAdapter {
  return typeof (tool as Partial<SiteAutomationAdapter>).matches === 'function';
}
