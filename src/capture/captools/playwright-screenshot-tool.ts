import { existsSync } from 'node:fs';

import { chromium, type Browser, type Page } from 'playwright';

import type { CaptureInput, CaptureTool, CaptureToolResult } from '../types.js';

const HAS_SYSTEM_CHROME =
  process.platform === 'darwin' && existsSync('/Applications/Google Chrome.app');

export async function captureFullPagePng(page: Pick<Page, 'screenshot'>): Promise<Buffer> {
  return page.screenshot({
    fullPage: true,
    type: 'png',
  });
}

export class PlaywrightScreenshotTool implements CaptureTool {
  readonly name = 'playwright-screenshot';
  readonly capabilities = ['screenshot'] as const;

  async capture(input: CaptureInput): Promise<CaptureToolResult> {
    let browser: Browser | null = null;
    let page: Page | null = null;

    try {
      browser = await chromium.launch(
        HAS_SYSTEM_CHROME ? { channel: 'chrome' as const } : undefined,
      );
      page = await browser.newPage();
      await page.goto(input.url, {
        waitUntil: 'load',
        timeout: 45_000,
      });
      await page.waitForTimeout(3000);

      return {
        toolName: this.name,
        finalUrl: page.url(),
        screenshot: await captureFullPagePng(page),
        screenshotExtension: 'png',
      };
    } finally {
      await page?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
  }
}
