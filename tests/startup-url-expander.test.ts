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

  it('skips failed top-level sitemaps while keeping seeds, other sitemaps, and inventory', async () => {
    const errors: Array<{ sitemapUrl: string; error: Error }> = [];
    const fetchImpl = vi.fn<(typeof fetch)>().mockImplementation(async (input) => {
      const url = String(input);

      if (url === 'https://example.com/broken-sitemap.xml') {
        return new Response('server error', { status: 500 });
      }

      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/from-working-page</loc></url>
</urlset>`,
        { status: 200 },
      );
    });

    await expect(
      expandStartupUrlCandidates({
        seedUrls: ['https://example.com/seed'],
        sitemapUrls: [
          'https://example.com/broken-sitemap.xml',
          'https://example.com/working-sitemap.xml',
        ],
        knownUrls: ['https://example.com/known'],
        fetchImpl,
        onSitemapError(error) {
          errors.push(error);
        },
      }),
    ).resolves.toEqual([
      {
        url: 'https://example.com/seed',
        discoverySource: 'seed_url',
      },
      {
        url: 'https://example.com/from-working-page',
        discoverySource: 'sitemap',
      },
      {
        url: 'https://example.com/known',
        discoverySource: 'inventory',
      },
    ]);

    expect(errors).toHaveLength(1);
    expect(errors[0].sitemapUrl).toBe('https://example.com/broken-sitemap.xml');
    expect(errors[0].error.message).toContain('500');
  });

  it('skips failed nested sitemaps while keeping sibling sitemap pages', async () => {
    const errors: Array<{ sitemapUrl: string; error: Error }> = [];
    const fetchImpl = vi.fn<(typeof fetch)>().mockImplementation(async (input) => {
      const url = String(input);

      if (url === 'https://example.com/sitemap.xml') {
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/broken-products-sitemap.xml</loc></sitemap>
  <sitemap><loc>https://example.com/content-sitemap.xml</loc></sitemap>
</sitemapindex>`,
          { status: 200 },
        );
      }

      if (url === 'https://example.com/broken-products-sitemap.xml') {
        return new Response('server error', { status: 500 });
      }

      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/docs</loc></url>
</urlset>`,
        { status: 200 },
      );
    });

    await expect(
      expandStartupUrlCandidates({
        seedUrls: [],
        sitemapUrls: ['https://example.com/sitemap.xml'],
        knownUrls: [],
        fetchImpl,
        onSitemapError(error) {
          errors.push(error);
        },
      }),
    ).resolves.toEqual([
      {
        url: 'https://example.com/docs',
        discoverySource: 'sitemap',
      },
    ]);

    expect(errors).toHaveLength(1);
    expect(errors[0].sitemapUrl).toBe('https://example.com/broken-products-sitemap.xml');
    expect(errors[0].error.message).toContain('500');
  });
});
