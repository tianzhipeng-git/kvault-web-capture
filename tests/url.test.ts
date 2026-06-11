import { describe, expect, it } from 'vitest';

import { mergeUrlNormalizationConfigs, normalizeUrl } from '../src/utils/url.js';

describe('normalizeUrl', () => {
  it('removes fragments, tracking params, and normalizes host/query order', () => {
    expect(
      normalizeUrl(
        'https://Example.COM/docs/?b=2&utm_source=test&a=1#section',
        {
          stripQueryParams: ['wbraid', 'gbraid', 'ref'],
          stripQueryParamPrefixes: ['utm_'],
        },
      ),
    ).toBe('https://example.com/docs?a=1&b=2');
  });

  it('removes configured query params case-insensitively', () => {
    expect(
      normalizeUrl(
        'https://example.com/docs?sessionId=abc&a=1&Preview=true',
        { stripQueryParams: ['sessionid', 'preview'] },
      ),
    ).toBe('https://example.com/docs?a=1');
  });

  it('merges system and site URL normalization config', () => {
    expect(
      mergeUrlNormalizationConfigs(
        { stripQueryParams: ['ref'], stripQueryParamPrefixes: ['utm_'] },
        { stripQueryParams: ['sessionId'], stripQueryParamPrefixes: ['preview_'] },
      ),
    ).toEqual({
      stripQueryParams: ['ref', 'sessionid'],
      stripQueryParamPrefixes: ['utm_', 'preview_'],
    });
  });
});
