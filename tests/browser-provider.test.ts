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
    }).browserProcesses.set('chromium:run:1:cdp:0', {
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

  it('allows one concurrent lease per configured CDP pool slot', async () => {
    const manager = new PlaywrightBrowserManager({
      browser: {
        engine: 'chromium',
        profileMode: 'ephemeral',
        cdpPoolSize: 2,
      },
    });
    const identity: BrowserIdentity = {
      runId: 2,
      siteId: 1,
      engine: 'chromium',
      profileMode: 'ephemeral',
    };
    const runtime = {
      requestId: 'pooled-request',
      sendRequest: async () => { throw new Error('not used'); },
    };
    const browserProcesses = (manager as unknown as {
      browserProcesses: Map<string, unknown>;
    }).browserProcesses;
    for (const slot of [0, 1]) {
      browserProcesses.set(`chromium:run:2:cdp:${slot}`, {
        browser: {
          isConnected: () => true,
          close: async () => {},
        },
        cdpHttpUrl: `http://127.0.0.1:922${slot}`,
        cdpWebSocketUrl: `ws://127.0.0.1:922${slot}/devtools/browser/test`,
      });
    }

    const first = await manager.acquireCdpEndpoint({ identity, runtime });
    const second = await manager.acquireCdpEndpoint({ identity, runtime });
    let thirdAcquired = false;
    const thirdPromise = manager.acquireCdpEndpoint({ identity, runtime }).then((lease) => {
      thirdAcquired = true;
      return lease;
    });

    await Promise.resolve();
    expect(new Set([first.cdpHttpUrl, second.cdpHttpUrl])).toEqual(new Set([
      'http://127.0.0.1:9220',
      'http://127.0.0.1:9221',
    ]));
    expect(thirdAcquired).toBe(false);

    await first.release();
    const third = await thirdPromise;
    expect(thirdAcquired).toBe(true);
    expect(third.cdpHttpUrl).toBe(first.cdpHttpUrl);

    await second.release();
    await third.release();
    await manager.close();
  });
});
