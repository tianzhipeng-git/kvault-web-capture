import { describe, expect, it } from 'vitest';

import { resolveCaptureConcurrency } from '../src/crawlee/capture-concurrency.js';
import { createDefaultSiteConfig } from '../src/config/site-config.js';

describe('resolveCaptureConcurrency', () => {
  it('aligns Python CDP capture concurrency with the browser pool', () => {
    const config = createDefaultSiteConfig('https://example.com');
    config.captureProfile = { tools: ['scrapling-page', 'defuddle-markdown'] };
    config.browser = {
      engine: 'cloakbrowser',
      profileMode: 'ephemeral',
      cdpPoolSize: 2,
    };

    expect(resolveCaptureConcurrency(config)).toBe(2);
  });

  it('keeps normal crawler concurrency when no Python CDP tool is selected', () => {
    const config = createDefaultSiteConfig('https://example.com');
    config.captureProfile = {
      tools: ['http-base', 'defuddle-markdown', 'playwright-screenshot'],
    };

    expect(resolveCaptureConcurrency(config)).toBe(5);
  });
});
