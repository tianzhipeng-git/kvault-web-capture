import { describe, expect, it } from 'vitest';

import { HttpBaseTool } from '../src/capture/captools/index.js';
import type { RuntimeContext } from '../src/capture/types.js';
import { createDefaultSiteConfig } from '../src/config/site-config.js';

describe('HttpBaseTool', () => {
  it('fails non-success HTTP responses before parsing the body', async () => {
    const runtime: RuntimeContext = {
      requestId: 'test-request',
      async sendRequest() {
        return {
          statusCode: 404,
          body: 'not found',
        };
      },
    };

    await expect(
      new HttpBaseTool().capture({
        runId: 1,
        siteId: 1,
        url: 'http://127.0.0.1:4318/not-exists',
        normalizedUrl: 'http://127.0.0.1:4318/not-exists',
        needs: ['base'],
        siteConfig: createDefaultSiteConfig('http://127.0.0.1:4318'),
        runtime,
      }),
    ).rejects.toThrow('HTTP base request failed with status 404');
  });

  it('uses site URL normalization config for extracted final URL', async () => {
    const runtime: RuntimeContext = {
      requestId: 'test-request',
      async sendRequest() {
        return {
          statusCode: 200,
          url: 'https://example.com/docs?sessionId=abc&a=1',
          body: '<html><title>Docs</title><body>hello</body></html>',
        };
      },
    };
    const siteConfig = {
      ...createDefaultSiteConfig('https://example.com'),
      urlNormalization: {
        stripQueryParams: ['sessionId'],
      },
    };

    const result = await new HttpBaseTool().capture({
      runId: 1,
      siteId: 1,
      url: 'https://example.com/docs?sessionId=abc&a=1',
      normalizedUrl: 'https://example.com/docs?a=1',
      needs: ['base'],
      siteConfig,
      runtime,
    });

    expect(result.extracted?.normalizedUrl).toBe('https://example.com/docs?a=1');
  });

  it('extracts plain text responses without parsing them as HTML', async () => {
    const runtime: RuntimeContext = {
      requestId: 'test-request',
      async sendRequest() {
        return {
          statusCode: 200,
          url: 'https://example.com/agents.md',
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          body: '# Agents\n\nCrawler guidance.',
        };
      },
    };

    const result = await new HttpBaseTool().capture({
      runId: 1,
      siteId: 1,
      url: 'https://example.com/agents.md',
      normalizedUrl: 'https://example.com/agents.md',
      needs: ['base'],
      siteConfig: createDefaultSiteConfig('https://example.com'),
      runtime,
    });

    expect(result.extracted).toMatchObject({
      bodyText: '# Agents Crawler guidance.',
      links: [],
      title: '',
    });
  });
});
