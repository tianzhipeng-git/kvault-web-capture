import { Defuddle } from 'defuddle/node';

import {
  browserIdentityFromRuntime,
  PlaywrightBrowserManager,
  type BrowserManager,
} from '../browser-provider.js';
import { parseHtmlDocument } from '../html.js';
import type { CaptureInput, CaptureTool, CaptureToolResult } from '../types.js';
import {
  isPlainTextContentType,
  responseBody,
  responseContentType,
  responseFinalUrl,
  responseStatusCode,
} from './http-base-tool.js';

const JINA_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

function requireNonEmptyMarkdown(content: string, toolName: string): string {
  const trimmed = content.trim();

  if (trimmed === '') {
    throw new Error(`${toolName} returned empty markdown`);
  }

  return trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`;
}

export class DefuddleMarkdownTool implements CaptureTool {
  readonly name = 'defuddle-markdown';
  readonly capabilities = ['markdown'] as const;

  async capture(input: CaptureInput): Promise<CaptureToolResult> {
    const response = await input.runtime.sendRequest(input.url);
    const html = responseBody(response);
    const finalUrl = responseFinalUrl(response, input.url);
    if (isPlainTextContentType(responseContentType(response))) {
      return {
        toolName: this.name,
        finalUrl,
        statusCode: responseStatusCode(response),
        html,
        markdown: requireNonEmptyMarkdown(html, this.name),
        markdownToolName: this.name,
      };
    }
    const document = parseHtmlDocument(html);
    const result = await Defuddle(document, finalUrl, {
      markdown: true,
      useAsync: false,
    });

    return {
      toolName: this.name,
      finalUrl,
      statusCode: responseStatusCode(response),
      html,
      markdown: requireNonEmptyMarkdown(result.content ?? '', this.name),
      markdownToolName: this.name,
    };
  }
}

export class LightpandaMarkdownTool implements CaptureTool {
  readonly name = 'lightpanda-markdown';
  readonly capabilities = ['markdown'] as const;

  constructor(private readonly browserManager: BrowserManager = new PlaywrightBrowserManager()) {}

  async capture(input: CaptureInput): Promise<CaptureToolResult> {
    const identity = {
      ...browserIdentityFromRuntime({
        runId: input.runId,
        siteId: input.siteId,
        siteConfig: input.siteConfig,
        runtime: input.runtime,
      }),
      engine: 'lightpanda' as const,
    };
    const lease = await this.browserManager.acquirePage({
      identity,
      url: input.url,
      runtime: input.runtime,
    });

    try {
      await lease.page.goto(input.url, {
        waitUntil: 'load',
        timeout: 45_000,
      });
      const client = await lease.page.context().newCDPSession(lease.page);
      const result = await (client.send as (method: string, params: Record<string, unknown>) => Promise<unknown>)(
        'LP.getMarkdown',
        {},
      ) as { markdown?: unknown };
      const markdown = typeof result.markdown === 'string' ? result.markdown : '';

      return {
        toolName: this.name,
        finalUrl: lease.page.url(),
        markdown: requireNonEmptyMarkdown(markdown, this.name),
        markdownToolName: this.name,
      };
    } finally {
      await lease.release();
    }
  }
}

export class JinaMarkdownTool implements CaptureTool {
  readonly name = 'jina-markdown';
  readonly capabilities = ['markdown'] as const;

  constructor(
    private readonly token: string | null = process.env.JINA_API_TOKEN ?? null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async capture(input: CaptureInput): Promise<CaptureToolResult> {
    const headers: Record<string, string> = {
      'x-timeout': '10',
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    const init: RequestInit = {
      signal: AbortSignal.timeout(JINA_REQUEST_TIMEOUT_MS),
      headers,
    };

    let requestUrl: string;
    if (input.url.includes('#')) {
      requestUrl = 'https://r.jina.ai/';
      init.method = 'POST';
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = new URLSearchParams({ url: input.url }).toString();
    } else {
      requestUrl = `https://r.jina.ai/${input.url}`;
    }

    const response = await this.fetchImpl(requestUrl, init);

    if (!response.ok) {
      throw new Error(`Jina request failed with status ${response.status}`);
    }

    return {
      toolName: this.name,
      finalUrl: input.url,
      statusCode: response.status,
      markdown: requireNonEmptyMarkdown(await response.text(), this.name),
      markdownToolName: this.name,
    };
  }
}
