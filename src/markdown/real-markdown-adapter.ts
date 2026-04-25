import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { Defuddle } from 'defuddle/node';

import type { MarkdownCaptureAdapter, MarkdownCaptureContext, MarkdownCaptureResult } from './markdown-adapter.js';

const execFile = promisify(execFileCallback);

export interface MarkdownCaptureStrategy {
  readonly name: string;
  capture(url: string, context?: MarkdownCaptureContext): Promise<string>;
}

function requireNonEmptyMarkdown(content: string, strategyName: string): string {
  const trimmed = content.trim();

  if (trimmed === '') {
    throw new Error(`${strategyName} returned empty markdown`);
  }

  return trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`;
}

export class DefuddleMarkdownStrategy implements MarkdownCaptureStrategy {
  readonly name = 'defuddle';

  async capture(url: string, context?: MarkdownCaptureContext): Promise<string> {
    if (!context?.document) {
      throw new Error('Defuddle requires a DOM document from LinkeDOMCrawler');
    }

    const result = await Defuddle(context.document, context.finalUrl ?? url, {
      markdown: true,
      useAsync: false,
    });

    return requireNonEmptyMarkdown(result.content ?? '', this.name);
  }
}

export class LightpandaMarkdownStrategy implements MarkdownCaptureStrategy {
  readonly name = 'lightpanda';

  constructor(
    private readonly binaryPath: string = 'lightpanda',
    private readonly execFileFn: typeof execFile = execFile,
  ) {}

  async capture(url: string): Promise<string> {
    const { stdout, stderr } = await this.execFileFn(this.binaryPath, ['fetch', '--dump', 'markdown', url], {
      maxBuffer: 10 * 1024 * 1024,
    });

    if (stderr.trim() !== '') {
      const lower = stderr.toLowerCase();

      if (lower.includes('error') || lower.includes('failed')) {
        throw new Error(stderr.trim());
      }
    }

    return requireNonEmptyMarkdown(stdout, this.name);
  }
}

export class JinaMarkdownStrategy implements MarkdownCaptureStrategy {
  readonly name = 'jina';

  constructor(
    private readonly token: string | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async capture(url: string): Promise<string> {
    if (!this.token) {
      throw new Error('Missing JINA_API_TOKEN');
    }

    const response = await this.fetchImpl(`https://r.jina.ai/${url}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Jina request failed with status ${response.status}`);
    }

    return requireNonEmptyMarkdown(await response.text(), this.name);
  }
}

export class FallbackMarkdownCaptureAdapter implements MarkdownCaptureAdapter {
  readonly crawlerType = 'linkedom' as const;

  constructor(private readonly strategies: MarkdownCaptureStrategy[]) {}

  async capture(url: string, context?: MarkdownCaptureContext): Promise<MarkdownCaptureResult> {
    const errors: string[] = [];

    for (const strategy of this.strategies) {
      try {
        const content = await strategy.capture(url, context);
        return { content, strategyName: strategy.name };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${strategy.name}: ${message}`);
      }
    }

    throw new Error(`Markdown capture failed for ${url}. ${errors.join(' | ')}`);
  }
}

export function createDefaultMarkdownAdapter(): MarkdownCaptureAdapter {
  return new FallbackMarkdownCaptureAdapter([
    new DefuddleMarkdownStrategy(),
    new LightpandaMarkdownStrategy(),
    new JinaMarkdownStrategy(process.env.JINA_API_TOKEN ?? null),
  ]);
}
