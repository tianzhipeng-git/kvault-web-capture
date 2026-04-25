import type { ExtractedPage } from '../domain/types.js';
import { normalizeUrl } from '../utils/url.js';

interface SelectorResult {
  first(): SelectorResult;
  text(): string;
  attr(name: string): string | undefined;
  each?(callback: (index: number, element: SelectorResult) => void): void;
}

interface MinimalCheerioApi {
  (selector: string): SelectorResult;
}

/**
 * Extensions that are known to serve crawlable HTML content.
 *
 * Rule: if a URL path has a file extension AND it is NOT in this set, the link
 * is treated as a non-HTML asset (download, media, font, etc.) and dropped.
 * URLs with no extension (the vast majority of modern routes) are always kept.
 */
const HTML_PAGE_EXTENSIONS = new Set([
  // Static HTML
  'html', 'htm', 'shtml', 'xhtml',
  // PHP
  'php', 'php3', 'php4', 'php5', 'phtml',
  // ASP / ASP.NET
  'asp', 'aspx',
  // Java
  'jsp', 'jspx',
  // ColdFusion
  'cfm', 'cfml',
]);

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Returns true when the resolved URL should be skipped during link extraction.
 *
 * Filtered cases:
 * 1. Fragment-only hrefs (`#section`) — same-page anchor, not a separate page.
 * 2. Non-http(s) protocols — `mailto:`, `tel:`, `javascript:`, `ftp:`, etc.
 * 3. Known download / asset extensions — files that are never crawlable HTML.
 */
function shouldSkipHref(href: string, resolved: URL): boolean {
  // 1. Fragment-only link — the href itself starts with '#' (resolved URL keeps the base).
  if (href.startsWith('#')) {
    return true;
  }

  // 2. Non-http(s) protocol.
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    return true;
  }

  // 3. Extension whitelist — if the path has an extension and it is not a known
  //    HTML-serving extension, treat the link as a non-crawlable asset and drop it.
  const pathname = resolved.pathname;
  const lastSegment = pathname.split('/').at(-1) ?? '';
  const dotIndex = lastSegment.lastIndexOf('.');
  if (dotIndex !== -1) {
    const ext = lastSegment.slice(dotIndex + 1).toLowerCase();
    if (!HTML_PAGE_EXTENSIONS.has(ext)) {
      return true;
    }
  }

  return false;
}

export function extractPageContent(url: string, $: MinimalCheerioApi): ExtractedPage {
  const title = cleanText($('title').first().text());
  const metaDescription = cleanText($('meta[name="description"]').attr('content') ?? '');
  const bodyText = cleanText($('body').text());
  const links: string[] = [];
  const anchorSelection = $('a[href]');

  anchorSelection.each?.((_index, element) => {
    const elementSelector = $ as unknown as (selector: unknown) => SelectorResult;
    const href =
      typeof element?.attr === 'function'
        ? element.attr('href')
        : elementSelector(element).attr('href');

    if (!href) {
      return;
    }

    try {
      const resolved = new URL(href, url);

      if (shouldSkipHref(href, resolved)) {
        return;
      }

      links.push(resolved.toString());
    } catch {
      // Ignore malformed URLs discovered in page markup.
    }
  });

  return {
    url,
    normalizedUrl: normalizeUrl(url),
    title,
    metaDescription,
    bodyText,
    links,
  };
}
