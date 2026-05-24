import { describe, expect, it } from 'vitest';

import { PlaywrightScreenshotTool, captureFullPagePng } from '../src/capture/captools/index.js';
import type { BrowserProvider } from '../src/capture/browser-provider.js';
import type { RuntimeContext } from '../src/capture/types.js';

describe('captureFullPagePng', () => {
  it('returns a png buffer using page.screenshot with fullPage=true', async () => {
    const fakeData = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const screenshotCalls: Array<{ fullPage: boolean; type: string }> = [];
    const fakePage = {
      screenshot: async (opts: { fullPage: boolean; type: string }) => {
        screenshotCalls.push(opts);
        return fakeData;
      },
    };

    const result = await captureFullPagePng(fakePage as never);

    expect(result).toBe(fakeData);
    expect(screenshotCalls).toHaveLength(1);
    expect(screenshotCalls[0].fullPage).toBe(true);
    expect(screenshotCalls[0].type).toBe('png');
  });
});

describe('PlaywrightScreenshotTool', () => {
  it('uses BrowserProvider leases and releases them after capture', async () => {
    const events: string[] = [];
    const provider: BrowserProvider = {
      acquirePage: async () => ({
        page: {
          goto: async (url: string) => { events.push(`goto:${url}`); },
          waitForTimeout: async () => { events.push('wait'); },
          url: () => 'https://example.com/final',
          screenshot: async () => Buffer.from('png'),
        } as never,
        release: async () => { events.push('release'); },
      }),
    };
    const runtime: RuntimeContext = {
      requestId: 'test-request',
      sendRequest: async () => { throw new Error('not used'); },
    };

    const result = await new PlaywrightScreenshotTool(provider).capture({
      url: 'https://example.com/start',
      normalizedUrl: 'https://example.com/start',
      needs: ['screenshot'],
      siteConfig: {
        seedUrls: [],
        sitemaps: [],
        rulesBeforeBaseEq: [],
        rulesBeforeStage2Eq: [],
        runOptions: { seedMaxDepth: 0, crawlMaxDepth: 0 },
      },
      runtime,
    });

    expect(result.finalUrl).toBe('https://example.com/final');
    expect(result.screenshot?.toString()).toBe('png');
    expect(events).toEqual(['goto:https://example.com/start', 'wait', 'release']);
  });
});
