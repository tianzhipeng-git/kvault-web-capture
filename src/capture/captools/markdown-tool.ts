import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { Defuddle } from 'defuddle/node';

import { parseHtmlDocument } from '../html.js';
import type { CaptureInput, CaptureTool, CaptureToolResult } from '../types.js';
import { responseBody, responseFinalUrl, responseStatusCode } from './http-base-tool.js';

const execFile = promisify(execFileCallback);

export interface MarkdownStrategyContext {
  document?: Document;
  finalUrl?: string;
  html?: string;
}

export interface MarkdownCaptureStrategy {
  readonly name: string;
  readonly needsDocument?: boolean;
  capture(url: string, context?: MarkdownStrategyContext): Promise<string>;
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
  readonly needsDocument = true;

  async capture(url: string, context?: MarkdownStrategyContext): Promise<string> {
    if (!context?.document) {
      throw new Error('Defuddle requires a DOM document');
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

export class MarkdownTool implements CaptureTool {
  readonly name = 'markdown';
  readonly capabilities = ['markdown'] as const;

  constructor(private readonly strategies: MarkdownCaptureStrategy[] = createDefaultMarkdownStrategies()) {}

  async capture(input: CaptureInput): Promise<CaptureToolResult> {
    const errors: string[] = [];
    let context: MarkdownStrategyContext | undefined;
    let statusCode: number | undefined;

    for (const strategy of this.strategies) {
      try {
        if (strategy.needsDocument && !context?.document) {
          const response = await input.runtime.sendRequest(input.url);
          const html = responseBody(response);
          context = {
            document: parseHtmlDocument(html),
            finalUrl: responseFinalUrl(response, input.url),
            html,
          };
          statusCode = responseStatusCode(response);
        }

        const markdown = await strategy.capture(input.url, context);
        return {
          toolName: this.name,
          finalUrl: context?.finalUrl ?? input.url,
          statusCode,
          html: context?.html,
          markdown,
          markdownStrategyName: strategy.name,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${strategy.name}: ${message}`);
      }
    }

    throw new Error(`Markdown capture failed for ${input.url}. ${errors.join(' | ')}`);
  }
}

export function createDefaultMarkdownStrategies(): MarkdownCaptureStrategy[] {
  return [
    new DefuddleMarkdownStrategy(),
    new LightpandaMarkdownStrategy(),
    new JinaMarkdownStrategy(process.env.JINA_API_TOKEN ?? null),
  ];
}
