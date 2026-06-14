import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { BrowserManager } from '../src/capture/browser-provider.js';
import { PageCaptureExecutor } from '../src/capture/executor.js';
import { PythonBridge, resolvePythonCommand } from '../src/capture/python-bridge.js';
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
      runId: 1,
      siteId: 1,
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

  it('returns partial artifact success when another requested artifact is missing', async () => {
    const executor = new PageCaptureExecutor([
      {
        name: 'partial-artifacts',
        capabilities: ['markdown', 'screenshot'],
        async capture() {
          return {
            toolName: 'partial-artifacts',
            markdown: '# Docs\n',
          };
        },
      },
    ]);

    const result = await executor.capture({
      runId: 1,
      siteId: 1,
      url: 'https://example.com/docs',
      normalizedUrl: 'https://example.com/docs',
      needs: ['markdown', 'screenshot'],
      siteConfig: createDefaultSiteConfig('https://example.com'),
      runtime,
    });

    expect(result.markdown?.content).toBe('# Docs\n');
    expect(result.screenshot).toBeUndefined();
    expect(result.diagnostics[0]).toMatchObject({
      toolName: 'partial-artifacts',
      status: 'succeeded',
    });
    expect(result.diagnostics[0].message).toContain('screenshot: missing');
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
      runId: 1,
      siteId: 1,
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
        runId: 1,
        siteId: 1,
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
      runId: 1,
      siteId: 1,
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
      runId: 1,
      siteId: 1,
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
      runId: 1,
      siteId: 1,
      url: 'https://example.com/docs',
      normalizedUrl: 'https://example.com/docs',
      needs: ['base', 'markdown'],
      siteConfig: {
        ...createDefaultSiteConfig('https://example.com'),
        captureProfile: {
          tools: ['bad-crawl4ai', 'fallback-base', 'fallback-markdown'],
        },
        validation: {
          markdown: { minLength: 5 },
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
      runId: 1,
      siteId: 1,
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
        runId: 1,
        siteId: 1,
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
      runId: 1,
      siteId: 1,
      url: 'https://example.com',
      normalizedUrl: 'https://example.com',
      needs: ['base'],
      siteConfig: createDefaultSiteConfig('https://example.com'),
      runtime,
    });

    expect(result.extracted).toBeUndefined();
  });

  it('passes BrowserManager CDP leases to Python bridge payloads and releases them', async () => {
    let stdinPayload: unknown = null;
    let releaseCount = 0;
    const browserManager: BrowserManager = {
      acquirePage: async () => { throw new Error('not used'); },
      acquireCdpEndpoint: async ({ identity }) => ({
        identity,
        cdpHttpUrl: 'http://127.0.0.1:9222',
        cdpWebSocketUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
        release: async () => { releaseCount += 1; },
      }),
      retireIdentity: async () => {},
      close: async () => {},
    };
    const bridge = new PythonBridge({
      toolName: 'fixture-python',
      scriptPath: '/fixture.py',
      browserManager,
      runProcessFn: async ({ stdin }) => {
        stdinPayload = JSON.parse(stdin);
        return {
          stdout: JSON.stringify({ title: 'ok' }),
          stderr: '',
        };
      },
    });

    await bridge.capture({
      runId: 10,
      siteId: 20,
      url: 'https://example.com',
      normalizedUrl: 'https://example.com',
      needs: ['base'],
      siteConfig: createDefaultSiteConfig('https://example.com'),
      runtime,
    });

    expect(stdinPayload).not.toBeNull();
    expect((stdinPayload as Record<string, unknown>).cdpHttpUrl).toBe('http://127.0.0.1:9222');
    expect((stdinPayload as Record<string, unknown>).cdpWebSocketUrl).toBe('ws://127.0.0.1:9222/devtools/browser/abc');
    expect(releaseCount).toBe(1);
  });

  it('resolves tool-specific python interpreters before shared fallbacks', async () => {
    const originalEnv = {
      KVAULT_PYTHON: process.env.KVAULT_PYTHON,
      KVAULT_PYTHON_CRAWL4AI: process.env.KVAULT_PYTHON_CRAWL4AI,
      KVAULT_PYTHON_SCRAPLING: process.env.KVAULT_PYTHON_SCRAPLING,
    };

    process.env.KVAULT_PYTHON = '/shared/python';
    process.env.KVAULT_PYTHON_CRAWL4AI = '/tool/crawl4ai-python';
    process.env.KVAULT_PYTHON_SCRAPLING = '/tool/scrapling-python';

    try {
      expect(resolvePythonCommand({ toolName: 'crawl4ai-page' })).toBe('/tool/crawl4ai-python');
      expect(resolvePythonCommand({ toolName: 'scrapling-page' })).toBe('/tool/scrapling-python');
      expect(resolvePythonCommand()).toBe('/shared/python');
    } finally {
      if (originalEnv.KVAULT_PYTHON === undefined) {
        delete process.env.KVAULT_PYTHON;
      } else {
        process.env.KVAULT_PYTHON = originalEnv.KVAULT_PYTHON;
      }
      if (originalEnv.KVAULT_PYTHON_CRAWL4AI === undefined) {
        delete process.env.KVAULT_PYTHON_CRAWL4AI;
      } else {
        process.env.KVAULT_PYTHON_CRAWL4AI = originalEnv.KVAULT_PYTHON_CRAWL4AI;
      }
      if (originalEnv.KVAULT_PYTHON_SCRAPLING === undefined) {
        delete process.env.KVAULT_PYTHON_SCRAPLING;
      } else {
        process.env.KVAULT_PYTHON_SCRAPLING = originalEnv.KVAULT_PYTHON_SCRAPLING;
      }
    }
  });

  it('prefers the shared project venv before legacy tool venvs', async () => {
    const originalEnv = {
      KVAULT_PYTHON: process.env.KVAULT_PYTHON,
      KVAULT_PYTHON_CRAWL4AI: process.env.KVAULT_PYTHON_CRAWL4AI,
      KVAULT_PYTHON_SCRAPLING: process.env.KVAULT_PYTHON_SCRAPLING,
    };
    const cwd = mkdtempSync(join(tmpdir(), 'kvault-python-'));
    const projectPython = join(cwd, '.venv', 'bin', 'python');
    const legacyPython = join(cwd, '.venv-crawl4ai', 'bin', 'python');
    mkdirSync(join(cwd, '.venv', 'bin'), { recursive: true });
    mkdirSync(join(cwd, '.venv-crawl4ai', 'bin'), { recursive: true });
    writeFileSync(projectPython, '');
    writeFileSync(legacyPython, '');

    delete process.env.KVAULT_PYTHON;
    delete process.env.KVAULT_PYTHON_CRAWL4AI;
    delete process.env.KVAULT_PYTHON_SCRAPLING;

    try {
      expect(resolvePythonCommand({ cwd, toolName: 'crawl4ai-page' })).toBe(projectPython);
    } finally {
      if (originalEnv.KVAULT_PYTHON === undefined) {
        delete process.env.KVAULT_PYTHON;
      } else {
        process.env.KVAULT_PYTHON = originalEnv.KVAULT_PYTHON;
      }
      if (originalEnv.KVAULT_PYTHON_CRAWL4AI === undefined) {
        delete process.env.KVAULT_PYTHON_CRAWL4AI;
      } else {
        process.env.KVAULT_PYTHON_CRAWL4AI = originalEnv.KVAULT_PYTHON_CRAWL4AI;
      }
      if (originalEnv.KVAULT_PYTHON_SCRAPLING === undefined) {
        delete process.env.KVAULT_PYTHON_SCRAPLING;
      } else {
        process.env.KVAULT_PYTHON_SCRAPLING = originalEnv.KVAULT_PYTHON_SCRAPLING;
      }
    }
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
        runId: 1,
        siteId: 1,
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
        runId: 1,
        siteId: 1,
        url: 'https://example.com/docs',
        normalizedUrl: 'https://example.com/docs',
        needs: ['base'],
        siteConfig: {
          ...createDefaultSiteConfig('https://example.com'),
          captureProfile: {
            tools: ['only-markdown'],
          },
        },
        runtime,
      }),
    ).rejects.toThrow('profile resolver returned no tools for needs base');
  });
});
