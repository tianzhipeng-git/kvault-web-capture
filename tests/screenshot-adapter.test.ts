import { describe, expect, it } from 'vitest';

import { PlaywrightScreenshotCaptureAdapter } from '../src/screenshot/real-screenshot-adapter.js';

describe('PlaywrightScreenshotCaptureAdapter', () => {
  it('throws when context is undefined', async () => {
    const adapter = new PlaywrightScreenshotCaptureAdapter();
    await expect(adapter.capture('https://example.com')).rejects.toThrow(
      'Playwright screenshot capture requires a page for https://example.com',
    );
  });

  it('throws when page is missing from context', async () => {
    const adapter = new PlaywrightScreenshotCaptureAdapter();
    await expect(adapter.capture('https://example.com', {})).rejects.toThrow(
      'Playwright screenshot capture requires a page for https://example.com',
    );
  });

  it('returns a png buffer using page.screenshot with fullPage=true', async () => {
    const fakeData = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const screenshotCalls: Array<{ fullPage: boolean; type: string }> = [];
    const fakePage = {
      screenshot: async (opts: { fullPage: boolean; type: string }) => {
        screenshotCalls.push(opts);
        return fakeData;
      },
    };

    const adapter = new PlaywrightScreenshotCaptureAdapter();
    const result = await adapter.capture('https://example.com', { page: fakePage as never });

    expect(result.data).toBe(fakeData);
    expect(result.extension).toBe('png');
    expect(screenshotCalls).toHaveLength(1);
    expect(screenshotCalls[0].fullPage).toBe(true);
    expect(screenshotCalls[0].type).toBe('png');
  });
});
