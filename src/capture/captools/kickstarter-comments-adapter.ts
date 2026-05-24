import { parseHtmlDocument } from '../html.js';
import type { CaptureInput, CaptureToolResult, SiteAutomationAdapter } from '../types.js';
import { responseBody, responseFinalUrl, responseStatusCode } from './http-base-tool.js';

interface KickstarterComment {
  id: string;
  author: string;
  body: string;
  createdAt: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function normalizeComment(value: unknown): KickstarterComment | null {
  if (!isRecord(value)) {
    return null;
  }

  const body = asString(value.body ?? value.comment ?? value.text).trim();
  if (body === '') {
    return null;
  }

  const authorValue = isRecord(value.author)
    ? value.author.name ?? value.author.screen_name ?? value.author.id
    : value.author ?? value.user_name ?? value.username;

  return {
    id: asString(value.id ?? value.comment_id ?? body.slice(0, 32)),
    author: asString(authorValue).trim() || 'unknown',
    body,
    createdAt: asString(value.created_at ?? value.createdAt ?? value.posted_at).trim() || null,
  };
}

function collectComments(value: unknown, output: KickstarterComment[], seen: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      const comment = normalizeComment(item);
      if (comment) {
        const key = `${comment.id}:${comment.body}`;
        if (!seen.has(key)) {
          output.push(comment);
          seen.add(key);
        }
      }
      collectComments(item, output, seen);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase().includes('comment')) {
      collectComments(child, output, seen);
    } else if (isRecord(child) || Array.isArray(child)) {
      collectComments(child, output, seen);
    }
  }
}

function parseScriptJsonComments(document: Document): KickstarterComment[] {
  const comments: KickstarterComment[] = [];
  const seen = new Set<string>();

  for (const script of Array.from(document.querySelectorAll('script'))) {
    const text = script.textContent?.trim() ?? '';
    if (text === '' || !text.includes('comment')) {
      continue;
    }

    const jsonText = text.startsWith('{') || text.startsWith('[')
      ? text
      : text.match(/({[\s\S]*})/)?.[1];
    if (!jsonText) {
      continue;
    }

    try {
      collectComments(JSON.parse(jsonText), comments, seen);
    } catch {
      // Ignore non-JSON scripts; Kickstarter pages often include mixed boot scripts.
    }
  }

  return comments;
}

function renderMarkdown(url: string, comments: KickstarterComment[]): string {
  return [
    '# Kickstarter comments',
    '',
    `Source: ${url}`,
    '',
    ...comments.flatMap((comment, index) => [
      `## Comment ${index + 1}`,
      '',
      `Author: ${comment.author}`,
      comment.createdAt ? `Created at: ${comment.createdAt}` : '',
      '',
      comment.body,
      '',
    ].filter(Boolean)),
  ].join('\n');
}

export class KickstarterCommentsAdapter implements SiteAutomationAdapter {
  readonly name = 'kickstarter-comments';
  readonly siteKey = 'kickstarter-comments';
  readonly capabilities = ['structured', 'markdown'] as const;

  matches(input: CaptureInput): boolean {
    try {
      const url = new URL(input.normalizedUrl);
      return url.hostname.endsWith('kickstarter.com') &&
        /\/projects\/[^/]+\/[^/]+/.test(url.pathname) &&
        (url.pathname.includes('/comments') || url.hash.includes('comments'));
    } catch {
      return false;
    }
  }

  async capture(input: CaptureInput): Promise<CaptureToolResult> {
    if (!this.matches(input)) {
      throw new Error(`Kickstarter comments adapter does not match ${input.normalizedUrl}`);
    }

    const response = await input.runtime.sendRequest(input.url);
    const html = responseBody(response);
    const finalUrl = responseFinalUrl(response, input.url);
    const document = parseHtmlDocument(html);
    const comments = parseScriptJsonComments(document);

    if (comments.length === 0) {
      throw new Error('Kickstarter comments adapter found no comments in page data');
    }

    return {
      toolName: this.name,
      finalUrl,
      statusCode: responseStatusCode(response),
      html,
      structured: {
        schema: 'kickstarter.comments.v1',
        sourceUrl: finalUrl,
        comments,
      },
      markdown: renderMarkdown(finalUrl, comments),
      markdownStrategyName: this.name,
    };
  }
}
