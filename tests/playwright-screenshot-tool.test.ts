import { describe, expect, it } from 'vitest';

import { captureFullPagePng } from '../src/capture/captools/index.js';

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
