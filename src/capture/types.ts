import type { CaptureCapability, ExtractedPage, SiteConfig } from '../domain/types.js';

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
  url: string;
  normalizedUrl: string;
  needs: CaptureCapability[];
  siteConfig: SiteConfig;
  runtime: RuntimeContext;
}

export interface CaptureToolResult {
  toolName: string;
  finalUrl?: string;
  statusCode?: number;
  html?: string;
  extracted?: ExtractedPage;
  markdown?: string;
  markdownStrategyName?: string;
  screenshot?: Buffer;
  screenshotExtension?: 'png';
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
    strategyName: string;
  };
  screenshot?: {
    data: Buffer;
    extension: 'png';
    toolName: string;
  };
  structured?: unknown;
  diagnostics: CaptureDiagnostic[];
}

export interface CaptureTool {
  readonly name: string;
  readonly capabilities: readonly CaptureCapability[];
  capture(input: CaptureInput): Promise<CaptureToolResult>;
}
