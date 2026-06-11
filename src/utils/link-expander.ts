import { parseHtmlDocument } from '../capture/html.js';

type FetchLike = typeof fetch;

export interface ExpandedLinks {
  sourceUrl: string;
  sourceType: 'sitemap' | 'page';
  links: string[];
}

function extractSitemapLocs(xml: string): string[] {
  return Array.from(parseHtmlDocument(xml).querySelectorAll('loc'))
    .map((element) => element.textContent.trim())
    .filter(Boolean);
}

function isSitemapIndex(body: string): boolean {
  return /<sitemapindex[\s>]/i.test(body);
}

function isSitemapUrlSet(body: string): boolean {
  return /<urlset[\s>]/i.test(body);
}

async function fetchBody(url: string, fetchImpl: FetchLike): Promise<string> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

async function expandSitemap(
  sitemapUrl: string,
  body: string,
  fetchImpl: FetchLike,
  visited: Set<string>,
): Promise<string[]> {
  if (visited.has(sitemapUrl)) {
    return [];
  }
  visited.add(sitemapUrl);

  const locs = extractSitemapLocs(body).map((loc) => new URL(loc, sitemapUrl).href);
  if (!isSitemapIndex(body)) {
    return locs;
  }

  const nestedLinks = await Promise.all(
    locs.map(async (nestedSitemapUrl) => (
      expandSitemap(
        nestedSitemapUrl,
        await fetchBody(nestedSitemapUrl, fetchImpl),
        fetchImpl,
        visited,
      )
    )),
  );
  return nestedLinks.flat();
}

function extractPageLinks(url: string, html: string): string[] {
  const document = parseHtmlDocument(html);
  const links: string[] = [];

  for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('#')) {
      continue;
    }

    try {
      const resolved = new URL(href, url);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
        links.push(resolved.href);
      }
    } catch {
      // Ignore malformed links in the source page.
    }
  }

  return links;
}

export async function expandLinks(
  inputUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<ExpandedLinks> {
  const sourceUrl = new URL(inputUrl).href;
  const body = await fetchBody(sourceUrl, fetchImpl);

  if (isSitemapIndex(body) || isSitemapUrlSet(body)) {
    return {
      sourceUrl,
      sourceType: 'sitemap',
      links: [...new Set(await expandSitemap(sourceUrl, body, fetchImpl, new Set<string>()))],
    };
  }

  return {
    sourceUrl,
    sourceType: 'page',
    links: [...new Set(extractPageLinks(sourceUrl, body))],
  };
}
