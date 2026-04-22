import type { ExtractedPage } from '../domain/types.js';
import { normalizeUrl } from '../utils/url.js';

interface SelectorResult {
  first(): SelectorResult;
  text(): string;
  attr(name: string): string | undefined;
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

  return {
    url,
    normalizedUrl: normalizeUrl(url),
    title,
    metaDescription,
    bodyText,
  };
}
