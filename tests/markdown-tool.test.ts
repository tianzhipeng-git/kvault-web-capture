import { describe, expect, it } from 'vitest';

import type { BrowserManager } from '../src/capture/browser-provider.js';
import {
  DefuddleMarkdownTool,
  JinaMarkdownTool,
  LightpandaMarkdownTool,
} from '../src/capture/captools/index.js';
import type { CaptureInput, RuntimeContext } from '../src/capture/types.js';

function makeInput(overrides: Partial<CaptureInput> = {}): CaptureInput {
  return {
    runId: 1,
    siteId: 1,
    url: 'https://example.com/docs',
    normalizedUrl: 'https://example.com/docs',
    needs: ['markdown'],
    siteConfig: {
      seedUrls: [],
      sitemaps: [],
      rulesBeforeBaseEq: [],
      rulesBeforeStage2Eq: [],
      runOptions: { seedMaxDepth: 0, crawlMaxDepth: 0, maxRequestRetries: 3 },
    },
    runtime: {
      requestId: 'test-request',
      async sendRequest() {
        throw new Error('not used');
      },
    },
    ...overrides,
  };
}

describe('DefuddleMarkdownTool', () => {
  it('converts fetched HTML into markdown', async () => {
    const runtime: RuntimeContext = {
      requestId: 'test-request',
      sendRequest: async () => ({
        statusCode: 200,
        url: 'https://example.com/docs',
        body: `<!doctype html>
          <html>
            <body>
              <article>
                <h1>Docs Title</h1>
                <p>Hello markdown world.</p>
              </article>
            </body>
          </html>`,
      }),
    };

    const result = await new DefuddleMarkdownTool().capture(makeInput({ runtime }));

    expect(result.toolName).toBe('defuddle-markdown');
    expect(result.markdown).toContain('Hello markdown world.');
    expect(result.markdownToolName).toBe('defuddle-markdown');
  });
});

describe('LightpandaMarkdownTool', () => {
  it('uses BrowserManager page leases and LP.getMarkdown', async () => {
    const events: string[] = [];
    const browserManager: BrowserManager = {
      acquirePage: async ({ identity }) => ({
        identity,
        page: {
          goto: async (url: string) => { events.push(`goto:${url}`); },
          url: () => 'https://example.com/final',
          context: () => ({
            newCDPSession: async () => ({
              send: async (method: string) => {
                events.push(`cdp:${method}`);
                return { markdown: '# Lightpanda result\n' };
              },
            }),
          }),
        } as never,
        release: async () => { events.push('release'); },
      }),
      acquireCdpEndpoint: async () => { throw new Error('not used'); },
      retireIdentity: async () => {},
      close: async () => {},
    };

    const result = await new LightpandaMarkdownTool(browserManager).capture(makeInput());

    expect(result.toolName).toBe('lightpanda-markdown');
    expect(result.finalUrl).toBe('https://example.com/final');
    expect(result.markdown).toBe('# Lightpanda result\n');
    expect(events).toEqual([
      'goto:https://example.com/docs',
      'cdp:LP.getMarkdown',
      'release',
    ]);
  });

  it('throws when LP.getMarkdown returns empty markdown', async () => {
    const browserManager: BrowserManager = {
      acquirePage: async ({ identity }) => ({
        identity,
        page: {
          goto: async () => {},
          url: () => 'https://example.com/final',
          context: () => ({
            newCDPSession: async () => ({
              send: async () => ({ markdown: '   ' }),
            }),
          }),
        } as never,
        release: async () => {},
      }),
      acquireCdpEndpoint: async () => { throw new Error('not used'); },
      retireIdentity: async () => {},
      close: async () => {},
    };

    await expect(new LightpandaMarkdownTool(browserManager).capture(makeInput())).rejects.toThrow(
      'lightpanda-markdown returned empty markdown',
    );
  });
});

describe('JinaMarkdownTool', () => {
  it('works without token and omits authorization header', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fakeFetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => '# ok\n' } as Response;
    };
    const result = await new JinaMarkdownTool(null, fakeFetch as typeof fetch).capture(makeInput());
    expect(result.markdown).toBe('# ok\n');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['x-timeout']).toBe('10');
    expect(headers['Authorization']).toBeUndefined();
  });

  it('throws when response is not ok', async () => {
    const fakeFetch = async () => ({ ok: false, status: 429 }) as Response;
    await expect(new JinaMarkdownTool('token', fakeFetch as typeof fetch).capture(makeInput())).rejects.toThrow(
      'Jina request failed with status 429',
    );
  });

  it('returns trimmed markdown with trailing newline on success', async () => {
    const fakeFetch = async () =>
      ({ ok: true, status: 200, text: async () => '# Heading\n\nContent here.' }) as Response;
    const result = await new JinaMarkdownTool('my-token', fakeFetch as typeof fetch).capture(makeInput());
    expect(result.markdown).toBe('# Heading\n\nContent here.\n');
    expect(result.markdownToolName).toBe('jina-markdown');
  });

  it('throws when response text is empty', async () => {
    const fakeFetch = async () => ({ ok: true, status: 200, text: async () => '   ' }) as Response;
    await expect(new JinaMarkdownTool('my-token', fakeFetch as typeof fetch).capture(makeInput())).rejects.toThrow(
      'jina-markdown returned empty markdown',
    );
  });

  it('calls the correct Jina URL with authorization header', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fakeFetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => '# ok\n' } as Response;
    };
    await new JinaMarkdownTool('test-token', fakeFetch as typeof fetch).capture(makeInput({
      url: 'https://example.com/page',
      normalizedUrl: 'https://example.com/page',
    }));

    expect(calls[0].url).toBe('https://r.jina.ai/https://example.com/page');
    expect((calls[0].init?.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer test-token',
    );
    expect((calls[0].init?.headers as Record<string, string>)['x-timeout']).toBe('10');
  });

  it('uses POST with url body when target URL contains a hash fragment', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fakeFetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => '# ok\n' } as Response;
    };
    await new JinaMarkdownTool('test-token', fakeFetch as typeof fetch).capture(makeInput({
      url: 'https://example.com/#/route',
      normalizedUrl: 'https://example.com/#/route',
    }));

    expect(calls[0].url).toBe('https://r.jina.ai/');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.body).toBe('url=https%3A%2F%2Fexample.com%2F%23%2Froute');
    expect((calls[0].init?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
  });
});
