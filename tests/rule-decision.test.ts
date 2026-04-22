import { describe, expect, it } from 'vitest';

import { buildStageDecision, evaluateTagRules, evaluateUrlRules } from '../src/rules/rule-decision.js';

describe('rule decision', () => {
  it('denies urls that match a blacklist before base capture', () => {
    const result = evaluateUrlRules('https://example.com/login', [
      {
        name: 'block-login',
        listType: 'blacklist',
        ruleType: 'prefix',
        values: ['example.com/login'],
      },
    ]);

    expect(result).toEqual({
      outcome: 'deny',
      matchedRuleName: 'block-login',
      reason: 'matched blacklist rule block-login',
    });
  });

  it('returns pending when no whitelist tag rule matches', () => {
    const result = evaluateTagRules(
      {
        tags: {
          content_type: ['generic'],
        },
      },
      [
        {
          name: 'docs-only',
          listType: 'whitelist',
          when: [
            {
              key: 'content_type',
              op: 'any_of',
              values: ['docs'],
            },
          ],
          artifacts: ['markdown'],
        },
      ],
    );

    expect(result).toEqual({
      outcome: 'pending',
      matchedRuleNames: [],
      requiredArtifacts: [],
      reason: 'no tag rule matched',
    });
  });

  it('turns preview allow decisions into preview_run pending pages', () => {
    const result = buildStageDecision({
      runType: 'inventory_preview',
      siteConfig: {
        seedUrls: ['https://example.com/docs'],
        sitemaps: [],
        urlRules: [],
        tagRules: [
          {
            name: 'docs-markdown',
            listType: 'whitelist',
            when: [
              {
                key: 'content_type',
                op: 'any_of',
                values: ['docs'],
              },
            ],
            artifacts: ['markdown'],
          },
        ],
        runOptions: {
          previewMaxDepth: 1,
          crawlMaxDepth: 2,
        },
      },
      classification: {
        tags: {
          content_type: ['docs'],
        },
      },
    });

    expect(result).toEqual({
      tagOutcome: 'allow',
      pageOutcome: 'pending',
      requiredArtifacts: ['markdown'],
      reason: null,
      pendingReason: 'preview_run',
      matchedRuleNames: ['docs-markdown'],
    });
  });
});
