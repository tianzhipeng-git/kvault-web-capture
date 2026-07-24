import { describe, expect, it } from 'vitest';

import { parseSiteConfig } from '../src/config/site-config.js';
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
        maxRequestRetries: 1,
      },
      urlNormalization: {
        stripQueryParams: ['sessionId'],
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
        maxRequestRetries: 1,
      },
      urlNormalization: {
        stripQueryParams: ['sessionId'],
      },
    });
  });

  it('preserves capture profile and validation fields', () => {
    const config = mapConfigFormToSiteConfig({
      seedUrls: ['https://example.com'],
      captureProfile: {
        tools: ['crawl4ai-page', 'http-base', 'defuddle-markdown'],
      },
      validation: {
        markdown: {
          minLength: 500,
          rejectRegex: ['Access Denied'],
        },
        screenshot: {
          minBytes: 20000,
        },
      },
    });

    expect(config.captureProfile?.tools).toEqual([
      'crawl4ai-page',
      'http-base',
      'defuddle-markdown',
    ]);
    expect(config.validation?.markdown?.minLength).toBe(500);
    expect(config.validation?.screenshot?.minBytes).toBe(20000);
  });

  it('preserves browser and proxy policy fields', () => {
    const config = mapConfigFormToSiteConfig({
      seedUrls: ['https://example.com'],
      browser: {
        engine: 'chromium',
        profileMode: 'ephemeral',
        reuse: 'run_browser',
        contextReuse: 'site_session_proxy',
        pageReuse: 'none',
        proxyBinding: 'session',
        cdpPoolSize: 2,
      },
      proxyPolicy: {
        mode: 'retry_on_failure',
        provider: 'crawlee',
      },
    });

    expect(config.browser).toEqual({
      engine: 'chromium',
      profileMode: 'ephemeral',
      reuse: 'run_browser',
      contextReuse: 'site_session_proxy',
      pageReuse: 'none',
      proxyBinding: 'session',
      cdpPoolSize: 2,
    });
    expect(config.proxyPolicy).toEqual({
      mode: 'retry_on_failure',
      provider: 'crawlee',
    });
  });

  it('preserves and validates complete screenshot configuration', () => {
    const config = mapConfigFormToSiteConfig({
      seedUrls: ['https://example.com'],
      screenshot: {
        mode: 'complete',
        variants: [{
          key: 'desktop',
          device: 'desktop',
          viewport: { width: 1440, height: 900 },
          deviceScaleFactor: 1,
        }],
      },
    });

    expect(config.screenshot?.mode).toBe('complete');
    expect(config.screenshot?.preparation?.maxCaptureHeight).toBe(50_000);
    expect(config.screenshot?.variants?.[0].key).toBe('desktop');
  });

  it('reports invalid capture profile and regex field names', () => {
    expect(() =>
      parseSiteConfig({
        seedUrls: ['https://example.com'],
        captureProfile: [],
      }),
    ).toThrow('captureProfile must be an object');

    expect(() =>
      parseSiteConfig({
        seedUrls: ['https://example.com'],
        validation: {
          markdown: {
            rejectRegex: ['['],
          },
        },
      }),
    ).toThrow('validation.markdown.rejectRegex contains invalid regex');

    expect(() =>
      parseSiteConfig({
        seedUrls: ['https://example.com'],
        browser: {
          engine: 'cloakbrowser',
          profileMode: 'ephemeral',
          cdpPoolSize: 5,
        },
      }),
    ).toThrow('browser.cdpPoolSize must be an integer between 1 and 4');
  });
});
