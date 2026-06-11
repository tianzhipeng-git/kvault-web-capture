import { describe, expect, it, vi } from 'vitest';

import { expandLinks } from '../src/utils/link-expander.js';

describe('link expander', () => {
  it('recursively expands a sitemap index', async () => {
    const fetchImpl = vi.fn<(typeof fetch)>().mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://example.com/map') {
        return new Response(`
          <sitemapindex>
            <sitemap><loc>/docs.xml</loc></sitemap>
            <sitemap><loc>/products.xml</loc></sitemap>
          </sitemapindex>
        `);
      }
      if (url === 'https://example.com/docs.xml') {
        return new Response('<urlset><url><loc>/docs/a</loc></url><url><loc>/docs/b?a=1&amp;b=2</loc></url></urlset>');
      }
      return new Response('<urlset><url><loc>/products/1</loc></url></urlset>');
    });

    await expect(expandLinks('https://example.com/map', fetchImpl)).resolves.toEqual({
      sourceUrl: 'https://example.com/map',
      sourceType: 'sitemap',
      links: [
        'https://example.com/docs/a',
        'https://example.com/docs/b?a=1&b=2',
        'https://example.com/products/1',
      ],
    });
  });

  it('fetches a page once and returns unique absolute child links', async () => {
    const fetchImpl = vi.fn<(typeof fetch)>().mockResolvedValue(new Response(`
      <html><body>
        <a href="/docs">Docs</a>
        <a href="/docs">Duplicate</a>
        <a href="https://other.example/page">Other</a>
        <a href="#section">Section</a>
        <a href="/asset.pdf">PDF</a>
      </body></html>
    `));

    await expect(expandLinks('https://example.com/start', fetchImpl)).resolves.toEqual({
      sourceUrl: 'https://example.com/start',
      sourceType: 'page',
      links: [
        'https://example.com/docs',
        'https://other.example/page',
        'https://example.com/asset.pdf',
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
