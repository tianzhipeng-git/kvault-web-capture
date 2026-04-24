import { describe, expect, it } from 'vitest';

import { mapConfigFormToSiteConfig } from '../src/web/services/config-mapper.js';

describe('web config mapper', () => {
  it('maps business form fields into SiteConfig', () => {
    const config = mapConfigFormToSiteConfig({
      seedUrls: ['https://example.com/docs'],
      sitemaps: ['https://example.com/sitemap.xml'],
      rulesBeforeBaseEq: [],
      rulesBeforeStage2Eq: [],
      runOptions: {
        seedMaxDepth: 2,
        crawlMaxDepth: 4,
      },
    });

    expect(config).toEqual({
      seedUrls: ['https://example.com/docs'],
      sitemaps: ['https://example.com/sitemap.xml'],
      rulesBeforeBaseEq: [],
      rulesBeforeStage2Eq: [],
      runOptions: {
        seedMaxDepth: 2,
        crawlMaxDepth: 4,
      },
    });
  });
});
