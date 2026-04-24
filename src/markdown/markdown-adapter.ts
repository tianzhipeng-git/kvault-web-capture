export interface MarkdownCaptureContext {
  document?: Document;
  finalUrl?: string;
  html?: string;
}

export interface MarkdownCaptureResult {
  content: string;
  strategyName: string;
}

export interface MarkdownCaptureAdapter {
  readonly crawlerType: 'basic' | 'jsdom';
  capture(url: string, context?: MarkdownCaptureContext): Promise<MarkdownCaptureResult>;
}
