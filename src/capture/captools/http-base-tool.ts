import { extractPageContentFromHtml } from '../html.js';
import type { CaptureInput, CaptureTool, CaptureToolResult } from '../types.js';

export function responseBody(response: unknown): string {
  const maybe = response as { body?: unknown };

  if (typeof maybe.body === 'string') {
    return maybe.body;
  }

  if (Buffer.isBuffer(maybe.body)) {
    return maybe.body.toString('utf8');
  }

  throw new Error('HTTP response did not include a string body');
}

export function responseStatusCode(response: unknown): number | undefined {
  const maybe = response as { statusCode?: unknown; status?: unknown };
  const status = typeof maybe.statusCode === 'number' ? maybe.statusCode : maybe.status;
  return typeof status === 'number' ? status : undefined;
}

export function responseFinalUrl(response: unknown, fallbackUrl: string): string {
  const maybe = response as { url?: unknown; request?: { url?: unknown } };
  return typeof maybe.url === 'string'
    ? maybe.url
    : typeof maybe.request?.url === 'string'
      ? maybe.request.url
      : fallbackUrl;
}

export class HttpBaseTool implements CaptureTool {
  readonly name = 'http-base';
  readonly capabilities = ['base'] as const;

  async capture(input: CaptureInput): Promise<CaptureToolResult> {
    const response = await input.runtime.sendRequest(input.url);
    const statusCode = responseStatusCode(response);

    if (statusCode !== undefined && statusCode >= 400) {
      throw new Error(`HTTP base request failed with status ${statusCode}`);
    }

    const html = responseBody(response);
    const finalUrl = responseFinalUrl(response, input.url);

    return {
      toolName: this.name,
      finalUrl,
      statusCode,
      html,
      extracted: extractPageContentFromHtml(finalUrl, html),
    };
  }
}
