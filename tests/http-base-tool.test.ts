import { describe, expect, it } from 'vitest';

import { HttpBaseTool } from '../src/capture/captools/index.js';
import type { RuntimeContext } from '../src/capture/types.js';
import { createDefaultSiteConfig } from '../src/config/site-config.js';

describe('HttpBaseTool', () => {
  it('fails non-success HTTP responses before parsing the body', async () => {
    const runtime: RuntimeContext = {
      requestId: 'test-request',
      async sendRequest() {
        return {
          statusCode: 404,
          body: 'not found',
        };
      },
    };

    await expect(
      new HttpBaseTool().capture({
        runId: 1,
        siteId: 1,
        url: 'http://127.0.0.1:4318/not-exists',
        normalizedUrl: 'http://127.0.0.1:4318/not-exists',
        needs: ['base'],
        siteConfig: createDefaultSiteConfig('http://127.0.0.1:4318'),
        runtime,
      }),
    ).rejects.toThrow('HTTP base request failed with status 404');
  });
});
