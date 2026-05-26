import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';

import {
  DefuddleMarkdownStrategy,
  JinaMarkdownStrategy,
  LightpandaMarkdownStrategy,
  MarkdownTool,
  type MarkdownCaptureStrategy,
} from '../src/capture/captools/index.js';
import type { RuntimeContext } from '../src/capture/types.js';

const runtime: RuntimeContext = {
  requestId: 'test-request',
  async sendRequest() {
    throw new Error('not used');
  },
};

describe('MarkdownTool', () => {
  it('stops at the first successful strategy', async () => {
    const calls: string[] = [];
    const tool = new MarkdownTool([
      {
        name: 'first',
        async capture() {
          calls.push('first');
          throw new Error('boom');
        },
      },
      {
        name: 'second',
        async capture() {
          calls.push('second');
          return '# ok\n';
        },
      },
      {
        name: 'third',
        async capture() {
          calls.push('third');
          return '# later\n';
        },
      },
    ] satisfies MarkdownCaptureStrategy[]);

    await expect(tool.capture({
      runId: 1,
      siteId: 1,
      url: 'https://example.com',
      normalizedUrl: 'https://example.com',
      needs: ['markdown'],
      siteConfig: {
        seedUrls: [],
        sitemaps: [],
        rulesBeforeBaseEq: [],
        rulesBeforeStage2Eq: [],
        runOptions: { seedMaxDepth: 0, crawlMaxDepth: 0 },
      },
      runtime,
    })).resolves.toMatchObject({
      markdown: '# ok\n',
      markdownStrategyName: 'second',
    });
    expect(calls).toEqual(['first', 'second']);
  });

  it('reports all fallback failures', async () => {
    const tool = new MarkdownTool([
      {
        name: 'first',
        async capture() {
          throw new Error('one');
        },
      },
      {
        name: 'second',
        async capture() {
          throw new Error('two');
        },
      },
    ] satisfies MarkdownCaptureStrategy[]);

    await expect(tool.capture({
      runId: 1,
      siteId: 1,
      url: 'https://example.com',
      normalizedUrl: 'https://example.com',
      needs: ['markdown'],
      siteConfig: {
        seedUrls: [],
        sitemaps: [],
        rulesBeforeBaseEq: [],
        rulesBeforeStage2Eq: [],
        runOptions: { seedMaxDepth: 0, crawlMaxDepth: 0 },
      },
      runtime,
    })).rejects.toThrow(
      'Markdown capture failed for https://example.com. first: one | second: two',
    );
  });
});

describe('JinaMarkdownStrategy', () => {
  it('throws when token is null', async () => {
    const strategy = new JinaMarkdownStrategy(null);
    await expect(strategy.capture('https://example.com')).rejects.toThrow('Missing JINA_API_TOKEN');
  });

  it('throws when response is not ok', async () => {
    const fakeFetch = async () => ({ ok: false, status: 429 }) as Response;
    const strategy = new JinaMarkdownStrategy('token', fakeFetch as typeof fetch);
    await expect(strategy.capture('https://example.com')).rejects.toThrow(
      'Jina request failed with status 429',
    );
  });

  it('returns trimmed markdown with trailing newline on success', async () => {
    const fakeFetch = async () =>
      ({ ok: true, text: async () => '# Heading\n\nContent here.' }) as Response;
    const strategy = new JinaMarkdownStrategy('my-token', fakeFetch as typeof fetch);
    const result = await strategy.capture('https://example.com');
    expect(result).toBe('# Heading\n\nContent here.\n');
  });

  it('throws when response text is empty', async () => {
    const fakeFetch = async () => ({ ok: true, text: async () => '   ' }) as Response;
    const strategy = new JinaMarkdownStrategy('my-token', fakeFetch as typeof fetch);
    await expect(strategy.capture('https://example.com')).rejects.toThrow(
      'jina returned empty markdown',
    );
  });

  it('calls the correct Jina URL with authorization header', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fakeFetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, text: async () => '# ok\n' } as Response;
    };
    const strategy = new JinaMarkdownStrategy('test-token', fakeFetch as typeof fetch);
    await strategy.capture('https://example.com/page');
    expect(calls[0].url).toBe('https://r.jina.ai/https://example.com/page');
    expect((calls[0].init?.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer test-token',
    );
  });
});

describe('LightpandaMarkdownStrategy', () => {
  function makeExecFile(stdout: string, stderr: string): () => Promise<{ stdout: string; stderr: string }> {
    return async () => ({ stdout, stderr });
  }

  it('returns markdown from stdout', async () => {
    const strategy = new LightpandaMarkdownStrategy('lightpanda', makeExecFile('# Lightpanda result\n', '') as never);
    await expect(strategy.capture('https://example.com')).resolves.toBe('# Lightpanda result\n');
  });

  it('throws when stderr contains "error"', async () => {
    const strategy = new LightpandaMarkdownStrategy('lightpanda', makeExecFile('', 'fetch error: connection refused') as never);
    await expect(strategy.capture('https://example.com')).rejects.toThrow(
      'fetch error: connection refused',
    );
  });

  it('throws when stderr contains "failed"', async () => {
    const strategy = new LightpandaMarkdownStrategy('lightpanda', makeExecFile('', 'request failed') as never);
    await expect(strategy.capture('https://example.com')).rejects.toThrow('request failed');
  });

  it('ignores non-error stderr (warnings)', async () => {
    const strategy = new LightpandaMarkdownStrategy('lightpanda', makeExecFile('# Content\n', 'some warning message') as never);
    await expect(strategy.capture('https://example.com')).resolves.toBe('# Content\n');
  });

  it('throws when stdout is empty', async () => {
    const strategy = new LightpandaMarkdownStrategy('lightpanda', makeExecFile('   \n  ', '') as never);
    await expect(strategy.capture('https://example.com')).rejects.toThrow(
      'lightpanda returned empty markdown',
    );
  });

  it('passes the correct binary path and arguments to execFile', async () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const fakeExecFile = async (bin: string, args: string[]) => {
      calls.push({ bin, args });
      return { stdout: '# ok\n', stderr: '' };
    };
    const strategy = new LightpandaMarkdownStrategy('/opt/lightpanda', fakeExecFile as never);
    await strategy.capture('https://example.com/page');
    expect(calls[0].bin).toBe('/opt/lightpanda');
    expect(calls[0].args).toEqual(['fetch', '--dump', 'markdown', 'https://example.com/page']);
  });
});

describe('DefuddleMarkdownStrategy', () => {
  it('converts a LinkeDOM document into markdown', async () => {
    const { document } = parseHTML(
      `<!doctype html>
      <html>
        <body>
          <article>
            <h1>Docs Title</h1>
            <p>Hello markdown world.</p>
          </article>
        </body>
      </html>`,
    );

    const markdown = await new DefuddleMarkdownStrategy().capture('https://example.com/docs', {
      document: document as unknown as Document,
      finalUrl: 'https://example.com/docs',
    });

    expect(markdown).toContain('Hello markdown world.');
    expect(markdown.startsWith('Hello markdown world.')).toBe(true);
  });
});
