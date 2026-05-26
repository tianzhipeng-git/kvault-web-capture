import { existsSync } from 'node:fs';

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
  cdpUrl: string;
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

export class PlaywrightBrowserManager implements BrowserManager {
  private readonly browserProcesses = new Map<string, BrowserProcessEntry>();

  private readonly contexts = new Map<string, BrowserContextEntry>();

  constructor(private readonly siteConfig?: { browser?: BrowserConfig }) {}

  async acquirePage(input: {
    identity: BrowserIdentity;
    url: string;
    runtime: RuntimeContext;
  }): Promise<PageLease> {
    if (input.identity.engine !== 'chromium') {
      throw new Error(`Browser engine ${input.identity.engine} is not implemented yet`);
    }

    const session = getRuntimeSession(input.runtime);
    if (session?.isUsable && !session.isUsable()) {
      throw new Error(`Crawlee session ${session.id ?? '(unknown)'} is not usable`);
    }

    const context = await this.getContext(input);
    const page = await context.newPage();
    let released = false;

    return {
      page,
      identity: input.identity,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        await this.syncCookiesToSession(context, input.url, input.runtime).catch(() => {});
        await page.close().catch(() => {});
      },
    };
  }

  async acquireCdpEndpoint(input: {
    identity: BrowserIdentity;
    runtime: RuntimeContext;
  }): Promise<CdpLease> {
    void input;
    throw new Error('CDP endpoint leases are not implemented for the Playwright native chromium engine yet');
  }

  async retireIdentity(identity: BrowserIdentity, reason: string): Promise<void> {
    void reason;
    const key = contextKey(identity, this.siteConfig?.browser);
    const entry = this.contexts.get(key);
    if (entry) {
      this.contexts.delete(key);
      await entry.context.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    const contexts = [...this.contexts.values()];
    this.contexts.clear();
    await Promise.all(contexts.map((entry) => entry.context.close().catch(() => {})));

    const browsers = [...this.browserProcesses.values()];
    this.browserProcesses.clear();
    await Promise.all(browsers.map((entry) => entry.browser.close().catch(() => {})));
  }

  private async getBrowser(identity: BrowserIdentity): Promise<Browser> {
    const key = processKey(identity, this.siteConfig?.browser);
    const existing = this.browserProcesses.get(key);
    if (existing?.browser.isConnected()) {
      return existing.browser;
    }

    const browser = await chromium.launch(
      HAS_SYSTEM_CHROME ? { channel: 'chrome' as const } : undefined,
    );
    this.browserProcesses.set(key, { browser });
    return browser;
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
  }
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
