import { describe, expect, it, vi } from 'vitest';

import {
  expandStartupUrlCandidates,
  resolveSitemapPageUrls,
} from '../src/planner/startup-url-expander.js';

describe('startup url expander', () => {
  it('recursively resolves sitemap indexes into page urls only', async () => {
    const fetchImpl = vi.fn<(typeof fetch)>().mockImplementation(async (input) => {
      const url = String(input);

      if (url === 'https://example.com/sitemap.xml') {
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/content-sitemap.xml</loc></sitemap>
</sitemapindex>`,
          { status: 200 },
        );
      }

      if (url === 'https://example.com/content-sitemap.xml') {
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/docs</loc></url>
  <url><loc>https://example.com/product</loc></url>
</urlset>`,
          { status: 200 },
        );
      }

      return new Response('not found', { status: 404 });
    });

    await expect(resolveSitemapPageUrls('https://example.com/sitemap.xml', fetchImpl)).resolves.toEqual([
      'https://example.com/docs',
      'https://example.com/product',
    ]);
  });

  it('merges seeds, sitemap pages, and inventory with stable source priority', async () => {
    const fetchImpl = vi.fn<(typeof fetch)>().mockResolvedValue(
      new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/docs</loc></url>
  <url><loc>https://example.com/product</loc></url>
</urlset>`,
        { status: 200 },
      ),
    );

    await expect(
      expandStartupUrlCandidates({
        seedUrls: ['https://example.com/docs'],
        sitemapUrls: ['https://example.com/sitemap.xml'],
        knownUrls: ['https://example.com/product', 'https://example.com/support'],
        fetchImpl,
      }),
    ).resolves.toEqual([
      {
        url: 'https://example.com/docs',
        discoverySource: 'seed_url',
      },
      {
        url: 'https://example.com/product',
        discoverySource: 'sitemap',
      },
      {
        url: 'https://example.com/support',
        discoverySource: 'inventory',
      },
    ]);
  });
});
