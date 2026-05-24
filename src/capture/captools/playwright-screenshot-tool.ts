import type { Page } from 'playwright';

import { PlaywrightBrowserProvider, type BrowserProvider } from '../browser-provider.js';
import type { CaptureInput, CaptureTool, CaptureToolResult } from '../types.js';

export async function captureFullPagePng(page: Pick<Page, 'screenshot'>): Promise<Buffer> {
  return page.screenshot({
    fullPage: true,
    type: 'png',
  });
}

export class PlaywrightScreenshotTool implements CaptureTool {
  readonly name = 'playwright-screenshot';
  readonly capabilities = ['screenshot'] as const;

  constructor(private readonly browserProvider: BrowserProvider = new PlaywrightBrowserProvider()) {}

  async capture(input: CaptureInput): Promise<CaptureToolResult> {
    const lease = await this.browserProvider.acquirePage({
      url: input.url,
      runtime: input.runtime,
    });

    try {
      await lease.page.goto(input.url, {
        waitUntil: 'load',
        timeout: 45_000,
      });
      await lease.page.waitForTimeout(3000);

      return {
        toolName: this.name,
        finalUrl: lease.page.url(),
        screenshot: await captureFullPagePng(lease.page),
        screenshotExtension: 'png',
      };
    } finally {
      await lease.release();
    }
  }
}
