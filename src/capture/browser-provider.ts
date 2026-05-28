import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';

import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from 'playwright';

import type {
  BrowserConfig,
  BrowserEngine,
  BrowserProfileMode,
} from '../domain/types.js';
import { logger } from '../utils/runtime-logger.js';
import type { RuntimeContext } from './types.js';

const HAS_SYSTEM_CHROME =
  process.platform === 'darwin' && existsSync('/Applications/Google Chrome.app');

export interface BrowserIdentity {
  siteId: number;
  runId: number;
  sessionId?: string;
  proxyKey?: string;
  engine: BrowserEngine;
  profileMode: BrowserProfileMode;
  profileKey?: string;
}

export interface PageLease {
  page: Page;
  identity: BrowserIdentity;
  release(): Promise<void>;
}

export interface CdpLease {
  cdpHttpUrl: string;
  cdpWebSocketUrl: string;
  identity: BrowserIdentity;
  release(): Promise<void>;
}

export interface BrowserManager {
  acquirePage(input: {
    identity: BrowserIdentity;
    url: string;
    runtime: RuntimeContext;
  }): Promise<PageLease>;
  acquireCdpEndpoint(input: {
    identity: BrowserIdentity;
    runtime: RuntimeContext;
  }): Promise<CdpLease>;
  retireIdentity(identity: BrowserIdentity, reason: string): Promise<void>;
  close(): Promise<void>;
}

export type BrowserLease = PageLease;
export type BrowserProvider = BrowserManager;

interface BrowserProcessEntry {
  browser: Browser;
  cdpHttpUrl?: string;
  cdpWebSocketUrl?: string;
  process?: ChildProcess;
}

interface BrowserContextEntry {
  context: BrowserContext;
  identity: BrowserIdentity;
}

interface CrawleeSessionLike {
  id?: string;
  userData?: Record<string, unknown>;
  isUsable?: () => boolean;
  getCookies?: (url: string) => unknown[] | Promise<unknown[]>;
  setCookies?: (cookies: unknown[], url: string) => void | Promise<void>;
  markBad?: () => void;
  retire?: () => void;
}

export function getRuntimeSession(runtime: RuntimeContext): CrawleeSessionLike | undefined {
  const session = runtime.session;
  return typeof session === 'object' && session !== null
    ? (session as CrawleeSessionLike)
    : undefined;
}

export function browserIdentityFromRuntime(input: {
  runId: number;
  siteId: number;
  siteConfig?: { browser?: BrowserConfig };
  runtime: RuntimeContext;
}): BrowserIdentity {
  const session = getRuntimeSession(input.runtime);
  const browserConfig = input.siteConfig?.browser;
  const profileKey = typeof session?.userData?.profileKey === 'string'
    ? session.userData.profileKey
    : undefined;
  const proxyKey = browserConfig?.proxyBinding === 'none'
    ? undefined
    : input.runtime.proxyInfo?.url;

  return {
    runId: input.runId,
    siteId: input.siteId,
    sessionId: typeof session?.id === 'string' ? session.id : undefined,
    proxyKey,
    engine: browserConfig?.engine ?? 'chromium',
    profileMode: browserConfig?.profileMode ?? 'ephemeral',
    profileKey,
  };
}

function processKey(identity: BrowserIdentity, browserConfig?: BrowserConfig): string {
  if (browserConfig?.reuse === 'site_browser') {
    return `${identity.engine}:site:${identity.siteId}`;
  }

  return `${identity.engine}:run:${identity.runId}`;
}

function contextKey(identity: BrowserIdentity, browserConfig?: BrowserConfig): string {
  if (browserConfig?.contextReuse === 'site_run') {
    return [
      identity.engine,
      identity.profileMode,
      `site:${identity.siteId}`,
      `run:${identity.runId}`,
    ].join('|');
  }

  return [
    identity.engine,
    identity.profileMode,
    `site:${identity.siteId}`,
    `session:${identity.sessionId ?? 'none'}`,
    `proxy:${identity.proxyKey ?? 'none'}`,
    `profile:${identity.profileKey ?? 'none'}`,
  ].join('|');
}

function assertSupportedBrowserEngine(engine: BrowserEngine): void {
  switch (engine) {
    case 'chromium':
    case 'cloakbrowser':
    case 'lightpanda':
      return;
    default:
      throw new Error(`Browser engine ${engine} is not implemented yet`);
  }
}

function redactUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);
    if (url.password) {
      url.password = '***';
    }
    if (url.username) {
      url.username = '***';
    }
    return url.toString();
  } catch {
    return value.includes('@') ? value.replace(/\/\/[^@]+@/, '//***:***@') : value;
  }
}

function browserIdentityLogMeta(identity: BrowserIdentity): Record<string, unknown> {
  return {
    siteId: identity.siteId,
    runId: identity.runId,
    sessionId: identity.sessionId,
    proxyKey: redactUrl(identity.proxyKey),
    engine: identity.engine,
    profileMode: identity.profileMode,
    profileKey: identity.profileKey,
  };
}

export class PlaywrightBrowserManager implements BrowserManager {
  private readonly browserProcesses = new Map<string, BrowserProcessEntry>();

  private readonly contexts = new Map<string, BrowserContextEntry>();

  constructor(private readonly siteConfig?: { browser?: BrowserConfig }) {}

  async acquirePage(input: {
    identity: BrowserIdentity;
    url: string;
    runtime: RuntimeContext;
  }): Promise<PageLease> {
    const startedAt = Date.now();
    assertSupportedBrowserEngine(input.identity.engine);

    const session = getRuntimeSession(input.runtime);
    if (session?.isUsable && !session.isUsable()) {
      logger.warn('Browser page lease rejected unusable session', {
        requestId: input.runtime.requestId,
        url: input.url,
        identity: browserIdentityLogMeta(input.identity),
        sessionId: session.id ?? null,
      });
      throw new Error(`Crawlee session ${session.id ?? '(unknown)'} is not usable`);
    }

    const context = await this.getContext(input);
    const page = await context.newPage();
    let released = false;
    logger.info('Browser page lease acquired', {
      requestId: input.runtime.requestId,
      url: input.url,
      identity: browserIdentityLogMeta(input.identity),
      durationMs: Date.now() - startedAt,
    });

    return {
      page,
      identity: input.identity,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        const releaseStartedAt = Date.now();
        await this.syncCookiesToSession(context, input.url, input.runtime).catch((error) => {
          logger.warn('Browser cookie sync to Crawlee session failed', {
            requestId: input.runtime.requestId,
            url: input.url,
            identity: browserIdentityLogMeta(input.identity),
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        });
        await page.close().catch(() => {});
        logger.info('Browser page lease released', {
          requestId: input.runtime.requestId,
          url: input.url,
          identity: browserIdentityLogMeta(input.identity),
          durationMs: Date.now() - releaseStartedAt,
        });
      },
    };
  }

  async acquireCdpEndpoint(input: {
    identity: BrowserIdentity;
    runtime: RuntimeContext;
  }): Promise<CdpLease> {
    const startedAt = Date.now();
    const entry = await this.getBrowserProcess(input.identity);
    if (!entry.cdpHttpUrl || !entry.cdpWebSocketUrl) {
      throw new Error(`CDP endpoint leases are not available for browser engine ${input.identity.engine}`);
    }

    logger.info('Browser CDP lease acquired', {
      requestId: input.runtime.requestId,
      identity: browserIdentityLogMeta(input.identity),
      cdpHttpUrl: entry.cdpHttpUrl,
      durationMs: Date.now() - startedAt,
    });
    return {
      cdpHttpUrl: entry.cdpHttpUrl,
      cdpWebSocketUrl: entry.cdpWebSocketUrl,
      identity: input.identity,
      release: async () => {
        logger.info('Browser CDP lease released', {
          requestId: input.runtime.requestId,
          identity: browserIdentityLogMeta(input.identity),
          cdpHttpUrl: entry.cdpHttpUrl,
        });
      },
    };
  }

  async retireIdentity(identity: BrowserIdentity, reason: string): Promise<void> {
    const key = contextKey(identity, this.siteConfig?.browser);
    const entry = this.contexts.get(key);
    if (entry) {
      this.contexts.delete(key);
      await entry.context.close().catch(() => {});
    }
    logger.warn('Browser identity retired', {
      identity: browserIdentityLogMeta(identity),
      reason,
      hadContext: entry !== undefined,
    });
  }

  async close(): Promise<void> {
    const contexts = [...this.contexts.values()];
    this.contexts.clear();
    await Promise.all(contexts.map((entry) => entry.context.close().catch(() => {})));

    const browsers = [...this.browserProcesses.values()];
    this.browserProcesses.clear();
    await Promise.all(browsers.map(async (entry) => {
      await entry.browser.close().catch(() => {});
      if (entry.process && !entry.process.killed) {
        entry.process.kill('SIGTERM');
      }
    }));
  }

  private async getBrowser(identity: BrowserIdentity): Promise<Browser> {
    return (await this.getBrowserProcess(identity)).browser;
  }

  private async getBrowserProcess(identity: BrowserIdentity): Promise<BrowserProcessEntry> {
    const key = processKey(identity, this.siteConfig?.browser);
    const existing = this.browserProcesses.get(key);
    if (existing?.browser.isConnected()) {
      return existing;
    }

    const entry = await this.launchBrowserProcess(identity);
    this.browserProcesses.set(key, entry);
    logger.info('Browser process launched', {
      identity: browserIdentityLogMeta(identity),
      processKey: key,
      cdpHttpUrl: entry.cdpHttpUrl,
    });
    return entry;
  }

  private async launchBrowserProcess(identity: BrowserIdentity): Promise<BrowserProcessEntry> {
    if (identity.engine === 'cloakbrowser') {
      return this.launchCloakBrowser(identity);
    }

    if (identity.engine === 'lightpanda') {
      return this.launchLightpanda(identity);
    }

    const port = await getFreePort();
    const cdpHttpUrl = `http://127.0.0.1:${port}`;
    const browser = await chromium.launch({
      ...(HAS_SYSTEM_CHROME ? { channel: 'chrome' as const } : {}),
      args: [
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=127.0.0.1',
      ],
    });
    const cdpWebSocketUrl = await readCdpWebSocketUrl(cdpHttpUrl);
    return { browser, cdpHttpUrl, cdpWebSocketUrl };
  }

  private async launchCloakBrowser(identity: BrowserIdentity): Promise<BrowserProcessEntry> {
    const { launch } = await importCloakBrowser();
    const port = await getFreePort();
    const cdpHttpUrl = `http://127.0.0.1:${port}`;
    const browser = await launch({
      headless: true,
      proxy: identity.proxyKey,
      args: [
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=127.0.0.1',
      ],
    });
    const cdpWebSocketUrl = await readCdpWebSocketUrl(cdpHttpUrl);
    return { browser, cdpHttpUrl, cdpWebSocketUrl };
  }

  private async launchLightpanda(identity: BrowserIdentity): Promise<BrowserProcessEntry> {
    const port = await getFreePort();
    const binary = process.env.LIGHTPANDA_BINARY ?? 'lightpanda';
    const args = ['serve', '--host', '127.0.0.1', '--port', String(port)];
    if (identity.proxyKey) {
      args.push('--http_proxy', identity.proxyKey);
    }

    const child = spawn(binary, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const cdpHttpUrl = `http://127.0.0.1:${port}`;

    try {
      const cdpWebSocketUrl = await waitForCdpWebSocketUrl(cdpHttpUrl);
      const browser = await chromium.connectOverCDP(cdpHttpUrl);
      return { browser, cdpHttpUrl, cdpWebSocketUrl, process: child };
    } catch (error) {
      if (!child.killed) {
        child.kill('SIGTERM');
      }
      throw error;
    }
  }

  private async getContext(input: {
    identity: BrowserIdentity;
    url: string;
    runtime: RuntimeContext;
  }): Promise<BrowserContext> {
    const key = contextKey(input.identity, this.siteConfig?.browser);
    const existing = this.contexts.get(key);
    if (existing) {
      return existing.context;
    }

    const browser = await this.getBrowser(input.identity);
    const options: BrowserContextOptions = {};
    if (input.identity.proxyKey) {
      options.proxy = { server: input.identity.proxyKey };
    }

    const context = await browser.newContext(options);
    await this.syncCookiesFromSession(context, input.url, input.runtime);
    this.contexts.set(key, { context, identity: input.identity });
    logger.info('Browser context created', {
      requestId: input.runtime.requestId,
      url: input.url,
      identity: browserIdentityLogMeta(input.identity),
      hasProxy: input.identity.proxyKey !== undefined,
    });
    return context;
  }

  private async syncCookiesFromSession(
    context: BrowserContext,
    url: string,
    runtime: RuntimeContext,
  ): Promise<void> {
    const session = getRuntimeSession(runtime);
    if (!session?.getCookies) {
      return;
    }

    const cookies = await session.getCookies(url);
    const playwrightCookies = cookies
      .map((cookie) => normalizeCookieForPlaywright(cookie, url))
      .filter((cookie): cookie is NonNullable<ReturnType<typeof normalizeCookieForPlaywright>> => cookie !== null);
    if (playwrightCookies.length > 0) {
      await context.addCookies(playwrightCookies);
    }
    logger.info('Synced Crawlee session cookies to browser context', {
      requestId: runtime.requestId,
      url,
      cookieCount: playwrightCookies.length,
    });
  }

  private async syncCookiesToSession(
    context: BrowserContext,
    url: string,
    runtime: RuntimeContext,
  ): Promise<void> {
    const session = getRuntimeSession(runtime);
    if (!session?.setCookies) {
      return;
    }

    const cookies = await context.cookies(url);
    await session.setCookies(cookies, url);
    logger.info('Synced browser context cookies to Crawlee session', {
      requestId: runtime.requestId,
      url,
      cookieCount: cookies.length,
    });
  }
}

async function importCloakBrowser(): Promise<{
  launch: (options: {
    headless?: boolean;
    proxy?: string;
    args?: string[];
  }) => Promise<Browser>;
}> {
  try {
    const moduleName = 'cloakbrowser';
    return await import(moduleName) as {
      launch: (options: {
        headless?: boolean;
        proxy?: string;
        args?: string[];
      }) => Promise<Browser>;
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cloakbrowser package is required for browser.engine=cloakbrowser: ${message}`);
  }
}

async function getFreePort(): Promise<number> {
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

async function waitForCdpWebSocketUrl(httpUrl: string): Promise<string> {
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

async function readCdpWebSocketUrl(httpUrl: string): Promise<string> {
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

function normalizeCookieForPlaywright(cookie: unknown, url: string) {
  if (typeof cookie !== 'object' || cookie === null) {
    return null;
  }

  const record = cookie as Record<string, unknown>;
  if (typeof record.name !== 'string' || typeof record.value !== 'string') {
    return null;
  }

  const sameSite: 'Strict' | 'Lax' | 'None' | undefined =
    record.sameSite === 'Strict' || record.sameSite === 'Lax' || record.sameSite === 'None'
      ? record.sameSite
      : undefined;
  const normalized = {
    name: record.name,
    value: record.value,
    url,
    expires: typeof record.expires === 'number' ? record.expires : undefined,
    httpOnly: typeof record.httpOnly === 'boolean' ? record.httpOnly : undefined,
    secure: typeof record.secure === 'boolean' ? record.secure : undefined,
    sameSite,
  };

  return normalized;
}
