import type { Page } from 'playwright';

export interface ScreenshotCaptureResult {
  data: Buffer;
  extension: 'png';
  toolName: string;
}

export interface ScreenshotCaptureContext {
  page?: Page;
  finalUrl?: string;
}

export interface ScreenshotCaptureAdapter {
  readonly crawlerType: 'basic' | 'playwright';
  capture(url: string, context?: ScreenshotCaptureContext): Promise<ScreenshotCaptureResult>;
}
