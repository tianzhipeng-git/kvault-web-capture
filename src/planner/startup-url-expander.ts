export interface StartupUrlCandidate {
  url: string;
  discoverySource: 'seed_url' | 'sitemap' | 'inventory';
}

type FetchLike = typeof fetch;

function extractSitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((match) => match[1].trim());
}

function looksLikeSitemap(url: string): boolean {
  const pathname = new URL(url).pathname.toLowerCase();
  return pathname.endsWith('.xml') || pathname.includes('sitemap');
}

async function resolveSitemapUrlsWithVisited(
  sitemapUrl: string,
  fetchImpl: FetchLike,
  visited: Set<string>,
): Promise<string[]> {
  if (visited.has(sitemapUrl)) {
    return [];
  }

  visited.add(sitemapUrl);

  const response = await fetchImpl(sitemapUrl);

  if (!response.ok) {
    throw new Error(`Failed to fetch sitemap ${sitemapUrl}: ${response.status}`);
  }

  const xml = await response.text();
  const locs = extractSitemapLocs(xml).map((loc) => new URL(loc, sitemapUrl).href);

  if (/<sitemapindex[\s>]/i.test(xml)) {
    const nestedUrls = await Promise.all(
      locs
        .filter(looksLikeSitemap)
        .map((nestedSitemapUrl) =>
          resolveSitemapUrlsWithVisited(nestedSitemapUrl, fetchImpl, visited),
        ),
    );

    return nestedUrls.flat();
  }

  return locs.filter((loc) => !looksLikeSitemap(loc));
}

export async function resolveSitemapPageUrls(
  sitemapUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<string[]> {
  return resolveSitemapUrlsWithVisited(sitemapUrl, fetchImpl, new Set<string>());
}

export async function expandStartupUrlCandidates(input: {
  seedUrls: string[];
  sitemapUrls: string[];
  knownUrls: string[];
  fetchImpl?: FetchLike;
}): Promise<StartupUrlCandidate[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sitemapPageUrls = (
    await Promise.all(input.sitemapUrls.map((sitemapUrl) => resolveSitemapPageUrls(sitemapUrl, fetchImpl)))
  ).flat();

  const orderedCandidates: StartupUrlCandidate[] = [
    ...input.seedUrls.map((url) => ({ url, discoverySource: 'seed_url' as const })),
    ...sitemapPageUrls.map((url) => ({ url, discoverySource: 'sitemap' as const })),
    ...input.knownUrls.map((url) => ({ url, discoverySource: 'inventory' as const })),
  ];

  const seen = new Set<string>();

  return orderedCandidates.filter((candidate) => {
    if (seen.has(candidate.url)) {
      return false;
    }

    seen.add(candidate.url);
    return true;
  });
}
