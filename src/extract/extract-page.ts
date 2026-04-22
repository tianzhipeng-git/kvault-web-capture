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

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
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
      links.push(new URL(href, url).toString());
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
