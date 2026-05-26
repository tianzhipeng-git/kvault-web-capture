import type { Page } from 'playwright';

import {
  browserIdentityFromRuntime,
  PlaywrightBrowserManager,
  type BrowserManager,
} from '../browser-provider.js';
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
  private readonly browserManager: BrowserManager;

  constructor(browserManager?: BrowserManager) {
    this.browserManager = browserManager ?? new PlaywrightBrowserManager();
  }

  async capture(input: CaptureInput): Promise<CaptureToolResult> {
    const lease = await this.browserManager.acquirePage({
      identity: browserIdentityFromRuntime({
        runId: input.runId,
        siteId: input.siteId,
        siteConfig: input.siteConfig,
        runtime: input.runtime,
      }),
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
