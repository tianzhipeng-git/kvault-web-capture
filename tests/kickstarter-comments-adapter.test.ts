import { describe, expect, it } from 'vitest';

import { KickstarterCommentsAdapter } from '../src/capture/captools/index.js';
import type { RuntimeContext } from '../src/capture/types.js';
import { createDefaultSiteConfig } from '../src/config/site-config.js';
import type { CaptureCapability } from '../src/domain/types.js';

function runtimeWithHtml(html: string): RuntimeContext {
  return {
    requestId: 'test-request',
    sendRequest: async () => ({
      statusCode: 200,
      url: 'https://www.kickstarter.com/projects/acme/widget/comments',
      body: html,
    }),
  };
}

describe('KickstarterCommentsAdapter', () => {
  it('matches kickstarter comments URLs and emits structured JSON plus markdown', async () => {
    const adapter = new KickstarterCommentsAdapter();
    const input = {
      runId: 1,
      siteId: 1,
      url: 'https://www.kickstarter.com/projects/acme/widget/comments',
      normalizedUrl: 'https://www.kickstarter.com/projects/acme/widget/comments',
      needs: ['structured', 'markdown'] satisfies CaptureCapability[],
      siteConfig: createDefaultSiteConfig('https://www.kickstarter.com'),
      runtime: runtimeWithHtml(`
        <html>
          <body>
            <script type="application/json">
              {
                "project": {
                  "comments": [
                    {
                      "id": 101,
                      "author": { "name": "Ada" },
                      "body": "First shipment looks great.",
                      "created_at": "2026-01-02T03:04:05Z"
                    }
                  ]
                }
              }
            </script>
          </body>
        </html>
      `),
    };

    expect(adapter.matches(input)).toBe(true);

    const result = await adapter.capture(input);

    expect(result.markdown).toContain('First shipment looks great.');
    expect(result.structured).toEqual({
      schema: 'kickstarter.comments.v1',
      sourceUrl: 'https://www.kickstarter.com/projects/acme/widget/comments',
      comments: [
        {
          id: '101',
          author: 'Ada',
          body: 'First shipment looks great.',
          createdAt: '2026-01-02T03:04:05Z',
        },
      ],
    });
  });

  it('does not match unrelated sites', () => {
    const adapter = new KickstarterCommentsAdapter();

    expect(adapter.matches({
      runId: 1,
      siteId: 1,
      url: 'https://example.com/comments',
      normalizedUrl: 'https://example.com/comments',
      needs: ['structured'],
      siteConfig: createDefaultSiteConfig('https://example.com'),
      runtime: runtimeWithHtml('<html></html>'),
    })).toBe(false);
  });
});
