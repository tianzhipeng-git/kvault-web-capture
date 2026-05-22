import { describe, expect, it } from 'vitest';

import { PageCaptureExecutor } from '../src/capture/executor.js';
import type { CaptureTool, RuntimeContext } from '../src/capture/types.js';
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
});
