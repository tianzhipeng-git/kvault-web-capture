import { createServer } from 'node:net';

import type { Browser } from 'playwright';

export async function importCloakBrowser(): Promise<{
  launch: (options: {
    headless?: boolean;
    humanize?: boolean;
    proxy?: string;
    args?: string[];
  }) => Promise<Browser>;
}> {
  try {
    const moduleName = 'cloakbrowser';
    return await import(moduleName) as {
      launch: (options: {
        headless?: boolean;
        humanize?: boolean;
        proxy?: string;
        args?: string[];
      }) => Promise<Browser>;
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cloakbrowser package is required for browser.engine=cloakbrowser: ${message}`);
  }
}

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address !== null) {
          resolve(address.port);
          return;
        }
        reject(new Error('Could not allocate a local port'));
      });
    });
  });
}

export async function waitForCdpWebSocketUrl(httpUrl: string): Promise<string> {
  const startedAt = Date.now();
  let lastError: Error | null = null;

  while (Date.now() - startedAt < 10_000) {
    try {
      return await readCdpWebSocketUrl(httpUrl);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error(`Timed out waiting for CDP endpoint at ${httpUrl}: ${lastError?.message ?? 'unknown error'}`);
}

export async function readCdpWebSocketUrl(httpUrl: string): Promise<string> {
  const response = await fetch(`${httpUrl}/json/version`);
  if (!response.ok) {
    throw new Error(`CDP version endpoint failed with status ${response.status}`);
  }

  const body = await response.json() as { webSocketDebuggerUrl?: unknown };
  if (typeof body.webSocketDebuggerUrl !== 'string' || body.webSocketDebuggerUrl === '') {
    throw new Error('CDP version endpoint did not return webSocketDebuggerUrl');
  }
  return body.webSocketDebuggerUrl;
}
