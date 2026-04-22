import { describe, expect, it } from 'vitest';

import { normalizeUrl } from '../src/utils/url.js';

describe('normalizeUrl', () => {
  it('removes fragments, tracking params, and normalizes host/query order', () => {
    expect(
      normalizeUrl('https://Example.COM/docs/?b=2&utm_source=test&a=1#section'),
    ).toBe('https://example.com/docs?a=1&b=2');
  });
});
