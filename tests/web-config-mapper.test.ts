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

  it('preserves capture profile and validation fields', () => {
    const config = mapConfigFormToSiteConfig({
      seedUrls: ['https://example.com'],
      captureProfiles: {
        default: {
          tools: ['crawl4ai-page', 'http-base', 'markdown'],
          validation: {
            markdown: {
              minLength: 500,
              rejectRegex: ['Access Denied'],
            },
          },
        },
      },
      defaultCaptureProfile: 'default',
      validation: {
        screenshot: {
          minBytes: 20000,
        },
      },
    });

    expect(config.captureProfiles?.default.tools).toEqual([
      'crawl4ai-page',
      'http-base',
      'markdown',
    ]);
    expect(config.captureProfiles?.default.validation?.markdown?.minLength).toBe(500);
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
    });
    expect(config.proxyPolicy).toEqual({
      mode: 'retry_on_failure',
      provider: 'crawlee',
    });
  });

  it('rejects dangling default capture profile and reports invalid regex field names', () => {
    expect(() =>
      parseSiteConfig({
        seedUrls: ['https://example.com'],
        defaultCaptureProfile: 'missing',
      }),
    ).toThrow('defaultCaptureProfile requires captureProfiles');

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
  });
});
