import { describe, expect, it } from 'vitest';

import { PageCaptureExecutor } from '../src/capture/executor.js';
import { PythonBridge } from '../src/capture/python-bridge.js';
import type { CaptureTool, RuntimeContext, SiteAutomationAdapter } from '../src/capture/types.js';
import { createDefaultSiteConfig } from '../src/config/site-config.js';

const runtime: RuntimeContext = {
  requestId: 'test-request',
  async sendRequest() {
    throw new Error('not used');
  },
};

describe('PageCaptureExecutor', () => {
  it('keeps partial successes and continues with remaining needs', async () => {
    const calls: string[] = [];
    const tools: CaptureTool[] = [
      {
        name: 'base-and-markdown',
        capabilities: ['base', 'markdown'],
        async capture() {
          calls.push('base-and-markdown');
          return {
            toolName: 'base-and-markdown',
            html: '<html><title>Docs</title><body>hello</body></html>',
            extracted: {
              url: 'https://example.com/docs',
              normalizedUrl: 'https://example.com/docs',
              title: 'Docs',
              metaDescription: '',
              bodyText: 'hello',
              links: [],
            },
            markdown: '# Docs\n',
          };
        },
      },
      {
        name: 'screenshot',
        capabilities: ['screenshot'],
        async capture() {
          calls.push('screenshot');
          return {
            toolName: 'screenshot',
            screenshot: Buffer.from('png'),
            screenshotExtension: 'png',
          };
        },
      },
    ];

    const result = await new PageCaptureExecutor(tools).capture({
      url: 'https://example.com/docs',
      normalizedUrl: 'https://example.com/docs',
      needs: ['base', 'markdown', 'screenshot'],
      siteConfig: createDefaultSiteConfig('https://example.com'),
      runtime,
    });

    expect(calls).toEqual(['base-and-markdown', 'screenshot']);
    expect(result.extracted?.title).toBe('Docs');
    expect(result.markdown?.content).toBe('# Docs\n');
    expect(result.screenshot?.data.toString()).toBe('png');
  });

  it('runs tools that cover only one of several remaining needs', async () => {
    const calls: Array<{ tool: string; needs: string[] }> = [];
    const tools: CaptureTool[] = [
      {
        name: 'base',
        capabilities: ['base'],
        async capture(input) {
          calls.push({ tool: 'base', needs: input.needs });
          return {
            toolName: 'base',
            html: '<html><title>Docs</title><body>hello</body></html>',
            extracted: {
              url: 'https://example.com/docs',
              normalizedUrl: 'https://example.com/docs',
              title: 'Docs',
              metaDescription: '',
              bodyText: 'hello',
              links: [],
            },
          };
        },
      },
      {
        name: 'markdown',
        capabilities: ['markdown'],
        async capture(input) {
          calls.push({ tool: 'markdown', needs: input.needs });
          return {
            toolName: 'markdown',
            markdown: '# Docs\n',
          };
        },
      },
      {
        name: 'screenshot',
        capabilities: ['screenshot'],
        async capture(input) {
          calls.push({ tool: 'screenshot', needs: input.needs });
          return {
            toolName: 'screenshot',
            screenshot: Buffer.from('png'),
            screenshotExtension: 'png',
          };
        },
      },
    ];

    const result = await new PageCaptureExecutor(tools).capture({
      url: 'https://example.com/docs',
      normalizedUrl: 'https://example.com/docs',
      needs: ['base', 'markdown', 'screenshot'],
      siteConfig: createDefaultSiteConfig('https://example.com'),
      runtime,
    });

    expect(calls).toEqual([
      { tool: 'base', needs: ['base'] },
      { tool: 'markdown', needs: ['markdown'] },
      { tool: 'screenshot', needs: ['screenshot'] },
    ]);
    expect(result.extracted?.title).toBe('Docs');
    expect(result.markdown?.content).toBe('# Docs\n');
    expect(result.screenshot?.data.toString()).toBe('png');
  });

  it('reports the missing capabilities when fallback cannot satisfy a need', async () => {
    const executor = new PageCaptureExecutor([
      {
        name: 'broken-markdown',
        capabilities: ['markdown'],
        async capture() {
          throw new Error('empty markdown');
        },
      },
    ]);

    await expect(
      executor.capture({
        url: 'https://example.com/docs',
        normalizedUrl: 'https://example.com/docs',
        needs: ['markdown'],
        siteConfig: createDefaultSiteConfig('https://example.com'),
        runtime,
      }),
    ).rejects.toThrow('missing markdown');
  });

  it('skips site automation adapters that do not match the URL', async () => {
    const adapter: SiteAutomationAdapter = {
      name: 'site-adapter',
      siteKey: 'special-site',
      capabilities: ['markdown'],
      matches: () => false,
      async capture() {
        throw new Error('should not run');
      },
    };
    const markdownTool: CaptureTool = {
      name: 'markdown',
      capabilities: ['markdown'],
      async capture() {
        return {
          toolName: 'markdown',
          markdown: '# fallback\n',
        };
      },
    };

    const result = await new PageCaptureExecutor([adapter, markdownTool]).capture({
      url: 'https://example.com/docs',
      normalizedUrl: 'https://example.com/docs',
      needs: ['markdown'],
      siteConfig: createDefaultSiteConfig('https://example.com'),
      runtime,
    });

    expect(result.markdown?.content).toBe('# fallback\n');
    expect(result.diagnostics[0]).toMatchObject({
      toolName: 'site-adapter',
      status: 'skipped',
    });
  });

  it('records proxyPolicy diagnostics when a tool fails before fallback', async () => {
    const siteConfig = createDefaultSiteConfig('https://example.com');
    siteConfig.proxyPolicy = { mode: 'retry_on_failure', provider: 'apify' };

    const result = await new PageCaptureExecutor([
      {
        name: 'broken-markdown',
        capabilities: ['markdown'],
        async capture() {
          throw new Error('blocked');
        },
      },
      {
        name: 'markdown',
        capabilities: ['markdown'],
        async capture() {
          return {
            toolName: 'markdown',
            markdown: '# ok\n',
          };
        },
      },
    ]).capture({
      url: 'https://example.com/docs',
      normalizedUrl: 'https://example.com/docs',
      needs: ['markdown'],
      siteConfig,
      runtime,
    });

    expect(result.markdown?.content).toBe('# ok\n');
    expect(result.diagnostics[0].message).toContain('proxyPolicy=retry_on_failure');
    expect(result.diagnostics[0].message).toContain('provider=apify');
  });

  it('uses capture profile tool order and falls back after validator rejection', async () => {
    const calls: string[] = [];
    const tools: CaptureTool[] = [
      {
        name: 'bad-crawl4ai',
        capabilities: ['base', 'markdown'],
        async capture() {
          calls.push('bad-crawl4ai');
          return {
            toolName: 'bad-crawl4ai',
            statusCode: 200,
            html: '<html><title>Denied</title><body>Access Denied</body></html>',
            extracted: {
              url: 'https://example.com/docs',
              normalizedUrl: 'https://example.com/docs',
              title: 'Denied',
              metaDescription: '',
              bodyText: 'Access Denied',
              links: [],
            },
            markdown: 'Access Denied',
          };
        },
      },
      {
        name: 'fallback-base',
        capabilities: ['base'],
        async capture() {
          calls.push('fallback-base');
          return {
            toolName: 'fallback-base',
            statusCode: 200,
            html: '<html><title>Docs</title><body>Hello docs</body></html>',
            extracted: {
              url: 'https://example.com/docs',
              normalizedUrl: 'https://example.com/docs',
              title: 'Docs',
              metaDescription: '',
              bodyText: 'Hello docs',
              links: [],
            },
          };
        },
      },
      {
        name: 'fallback-markdown',
        capabilities: ['markdown'],
        async capture() {
          calls.push('fallback-markdown');
          return {
            toolName: 'fallback-markdown',
            markdown: '# Docs\n\nHello docs.\n',
          };
        },
      },
    ];

    const result = await new PageCaptureExecutor(tools).capture({
      url: 'https://example.com/docs',
      normalizedUrl: 'https://example.com/docs',
      needs: ['base', 'markdown'],
      siteConfig: {
        ...createDefaultSiteConfig('https://example.com'),
        captureProfiles: {
          default: {
            tools: ['bad-crawl4ai', 'fallback-base', 'fallback-markdown'],
            validation: {
              markdown: { minLength: 5 },
            },
          },
        },
      },
      runtime,
    });

    expect(calls).toEqual(['bad-crawl4ai', 'fallback-base', 'fallback-markdown']);
    expect(result.extracted?.title).toBe('Docs');
    expect(result.markdown?.content).toBe('# Docs\n\nHello docs.\n');
    expect(result.diagnostics[0]).toMatchObject({
      toolName: 'bad-crawl4ai',
      status: 'failed',
    });
    expect(result.diagnostics[0].message).toContain('rejectRegex');
  });

  it('parses Python bridge JSON, base64 buffers, stderr diagnostics, and invalid JSON failures', async () => {
    const bridge = new PythonBridge({
      toolName: 'fixture-python',
      scriptPath: '/fixture.py',
      runProcessFn: async () => ({
        stdout: JSON.stringify({
          finalUrl: 'https://example.com/final',
          statusCode: 200,
          html: '<html></html>',
          title: 'Fixture',
          bodyText: 'Bridge text',
          links: ['https://example.com/next'],
          markdown: '# Fixture\n',
          screenshotBase64: Buffer.from('png').toString('base64'),
          structured: { ok: true },
        }),
        stderr: 'warning only\n',
      }),
    });

    const result = await bridge.capture({
      url: 'https://example.com',
      normalizedUrl: 'https://example.com',
      needs: ['base', 'markdown', 'screenshot', 'structured'],
      siteConfig: createDefaultSiteConfig('https://example.com'),
      runtime,
    });

    expect(result.extracted?.title).toBe('Fixture');
    expect(result.screenshot?.toString()).toBe('png');
    expect(result.structured).toEqual({ ok: true });
    expect(result.diagnostics?.stderr).toBe('warning only');

    const brokenBridge = new PythonBridge({
      toolName: 'broken-python',
      scriptPath: '/fixture.py',
      runProcessFn: async () => ({
        stdout: 'not json',
        stderr: 'traceback',
      }),
    });

    await expect(
      brokenBridge.capture({
        url: 'https://example.com',
        normalizedUrl: 'https://example.com',
        needs: ['base'],
        siteConfig: createDefaultSiteConfig('https://example.com'),
        runtime,
      }),
    ).rejects.toThrow('invalid JSON');
  });

  it('does not build extracted page from empty Python links alone', async () => {
    const bridge = new PythonBridge({
      toolName: 'fixture-python',
      scriptPath: '/fixture.py',
      runProcessFn: async () => ({
        stdout: JSON.stringify({
          links: [],
        }),
        stderr: '',
      }),
    });

    const result = await bridge.capture({
      url: 'https://example.com',
      normalizedUrl: 'https://example.com',
      needs: ['base'],
      siteConfig: createDefaultSiteConfig('https://example.com'),
      runtime,
    });

    expect(result.extracted).toBeUndefined();
  });

  it('validates base minLength against bodyText rather than raw HTML length', async () => {
    const executor = new PageCaptureExecutor([
      {
        name: 'taggy-base',
        capabilities: ['base'],
        async capture() {
          return {
            toolName: 'taggy-base',
            statusCode: 200,
            html: `<html>${'<div></div>'.repeat(1000)}<body>short</body></html>`,
            extracted: {
              url: 'https://example.com/docs',
              normalizedUrl: 'https://example.com/docs',
              title: 'Docs',
              metaDescription: '',
              bodyText: 'short',
              links: [],
            },
          };
        },
      },
    ]);

    await expect(
      executor.capture({
        url: 'https://example.com/docs',
        normalizedUrl: 'https://example.com/docs',
        needs: ['base'],
        siteConfig: {
          ...createDefaultSiteConfig('https://example.com'),
          validation: {
            base: {
              minLength: 100,
            },
          },
        },
        runtime,
      }),
    ).rejects.toThrow('bodyText length is below 100');
  });

  it('reports context when profile filtering leaves no usable tools', async () => {
    const executor = new PageCaptureExecutor([
      {
        name: 'only-markdown',
        capabilities: ['markdown'],
        async capture() {
          return {
            toolName: 'only-markdown',
            markdown: '# ok\n',
          };
        },
      },
    ]);

    await expect(
      executor.capture({
        url: 'https://example.com/docs',
        normalizedUrl: 'https://example.com/docs',
        needs: ['base'],
        siteConfig: {
          ...createDefaultSiteConfig('https://example.com'),
          captureProfiles: {
            default: {
              tools: ['only-markdown'],
            },
          },
        },
        runtime,
      }),
    ).rejects.toThrow('profile resolver returned no tools for needs base');
  });
});
