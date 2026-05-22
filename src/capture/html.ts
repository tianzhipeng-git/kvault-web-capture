import { parseHTML } from 'linkedom';

import type { ExtractedPage } from '../domain/types.js';
import { normalizeUrl } from '../utils/url.js';

const HTML_PAGE_EXTENSIONS = new Set([
  'html',
  'htm',
  'shtml',
  'xhtml',
  'php',
  'php3',
  'php4',
  'php5',
  'phtml',
  'asp',
  'aspx',
  'jsp',
  'jspx',
  'cfm',
  'cfml',
]);

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function shouldSkipHref(href: string, resolved: URL): boolean {
  if (href.startsWith('#')) {
    return true;
  }

  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    return true;
  }

  const lastSegment = resolved.pathname.split('/').at(-1) ?? '';
  const dotIndex = lastSegment.lastIndexOf('.');
  if (dotIndex !== -1) {
    const ext = lastSegment.slice(dotIndex + 1).toLowerCase();
    return !HTML_PAGE_EXTENSIONS.has(ext);
  }

  return false;
}

export function parseHtmlDocument(html: string): Document {
  return parseHTML(html).document;
}

export function extractPageContentFromHtml(url: string, html: string): ExtractedPage {
  const document = parseHtmlDocument(html);
  const title = cleanText(document.querySelector('title')?.textContent ?? '');
  const metaDescription = cleanText(
    document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '',
  );
  const bodyText = cleanText(document.body?.textContent ?? '');
  const links: string[] = [];

  for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
    const href = anchor.getAttribute('href');

    if (!href) {
      continue;
    }

    try {
      const resolved = new URL(href, url);

      if (!shouldSkipHref(href, resolved)) {
        links.push(resolved.toString());
      }
    } catch {
      // Malformed markup links are ignored at extraction time.
    }
  }

  return {
    url,
    normalizedUrl: normalizeUrl(url),
    title,
    metaDescription,
    bodyText,
    links,
  };
}
