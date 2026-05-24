import { existsSync } from 'node:fs';

import { chromium, type Browser, type Page } from 'playwright';

import type { RuntimeContext } from './types.js';

const HAS_SYSTEM_CHROME =
  process.platform === 'darwin' && existsSync('/Applications/Google Chrome.app');

export interface BrowserLease {
  page: Page;
  release(): Promise<void>;
}

export interface BrowserProvider {
  acquirePage(input: {
    url: string;
    runtime: RuntimeContext;
  }): Promise<BrowserLease>;
}

export class PlaywrightBrowserProvider implements BrowserProvider {
  async acquirePage(): Promise<BrowserLease> {
    const browser = await chromium.launch(
      HAS_SYSTEM_CHROME ? { channel: 'chrome' as const } : undefined,
    );
    const page = await browser.newPage();

    return {
      page,
      release: async () => {
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
      },
    };
  }
}
