import { describe, expect, it } from 'vitest';

import { PlaywrightBrowserManager, type BrowserIdentity } from '../src/capture/browser-provider.js';

describe('PlaywrightBrowserManager CDP leases', () => {
  it('serializes leases for the same browser process', async () => {
    const manager = new PlaywrightBrowserManager();
    const identity: BrowserIdentity = {
      runId: 1,
      siteId: 1,
      engine: 'chromium',
      profileMode: 'ephemeral',
    };
    const runtime = {
      requestId: 'test-request',
      sendRequest: async () => { throw new Error('not used'); },
    };

    (manager as unknown as {
      browserProcesses: Map<string, unknown>;
    }).browserProcesses.set('chromium:run:1', {
      browser: {
        isConnected: () => true,
        close: async () => {},
      },
      cdpHttpUrl: 'http://127.0.0.1:9222',
      cdpWebSocketUrl: 'ws://127.0.0.1:9222/devtools/browser/test',
    });

    const first = await manager.acquireCdpEndpoint({ identity, runtime });
    let secondAcquired = false;
    const secondPromise = manager.acquireCdpEndpoint({ identity, runtime }).then((lease) => {
      secondAcquired = true;
      return lease;
    });

    await Promise.resolve();
    expect(secondAcquired).toBe(false);

    await first.release();
    const second = await secondPromise;

    expect(secondAcquired).toBe(true);
    expect(second.cdpHttpUrl).toBe('http://127.0.0.1:9222');
    await second.release();
    await manager.close();
  });
});
