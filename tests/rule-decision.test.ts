import { describe, expect, it } from 'vitest';

import type { SiteConfig } from '../src/domain/types.js';
import {
  buildBaseEnqueueDecision,
  buildStage2EnqueueDecision,
  evaluateLabelRules,
  evaluateUrlRules,
} from '../src/rules/rule-decision.js';

describe('rule decision', () => {
  it('denies urls that match a blacklist before base capture', () => {
    const result = evaluateUrlRules('https://example.com/login', [
      {
        name: 'block-login',
        matchType: 'url',
        listType: 'blacklist',
        ruleType: 'prefix',
        values: ['example.com/login'],
      },
    ]);

    expect(result).toEqual({
      outcome: 'deny',
      matchedRuleNames: ['block-login'],
      requiredArtifacts: [],
      reason: 'matched blacklist rule block-login',
    });
  });

  it('requires every scopelist to match', () => {
    const result = evaluateUrlRules('https://example.com/docs', [
      {
        name: 'allow-example',
        matchType: 'url',
        listType: 'scopelist',
        ruleType: 'prefix',
        values: ['example.com'],
        artifacts: ['markdown'],
      },
      {
        name: 'allow-blog-only',
        matchType: 'url',
        listType: 'scopelist',
        ruleType: 'prefix',
        values: ['example.com/blog'],
      },
    ]);

    expect(result).toEqual({
      outcome: 'deny',
      matchedRuleNames: [],
      requiredArtifacts: [],
      reason: 'outside scopelist rule allow-blog-only',
    });
  });

  it('allows matching url whitelists and merges their artifacts', () => {
    const result = evaluateUrlRules('https://example.com/docs/api', [
      {
        name: 'allow-site',
        matchType: 'url',
        listType: 'scopelist',
        ruleType: 'prefix',
        values: ['example.com'],
      },
      {
        name: 'docs-markdown',
        matchType: 'url',
        listType: 'whitelist',
        ruleType: 'prefix',
        values: ['example.com/docs'],
        artifacts: ['markdown'],
      },
      {
        name: 'api-screenshot',
        matchType: 'url',
        listType: 'whitelist',
        ruleType: 'prefix',
        values: ['example.com/docs/api'],
        artifacts: ['screenshot'],
      },
    ]);

    expect(result).toEqual({
      outcome: 'allow',
      matchedRuleNames: ['allow-site', 'docs-markdown', 'api-screenshot'],
      requiredArtifacts: ['markdown', 'screenshot'],
      reason: null,
    });
  });

  it('returns pending when no whitelist label rule matches', () => {
    const result = evaluateLabelRules(
      {
        labels: {
          content_type: ['generic'],
        },
      },
      [
        {
          name: 'docs-only',
          matchType: 'label',
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
      reason: 'no label rule matched',
    });
  });

  it('requires every label scopelist to match', () => {
    const result = evaluateLabelRules(
      {
        labels: {
          content_type: ['docs'],
          audience: ['guest'],
        },
      },
      [
        {
          name: 'must-be-docs',
          matchType: 'label',
          listType: 'scopelist',
          when: [
            {
              key: 'content_type',
              op: 'any_of',
              values: ['docs'],
            },
          ],
          artifacts: ['markdown'],
        },
        {
          name: 'must-be-internal',
          matchType: 'label',
          listType: 'scopelist',
          when: [
            {
              key: 'audience',
              op: 'any_of',
              values: ['internal'],
            },
          ],
          artifacts: ['markdown'],
        },
      ],
    );

    expect(result).toEqual({
      outcome: 'deny',
      matchedRuleNames: [],
      requiredArtifacts: [],
      reason: 'outside scopelist rule must-be-internal',
    });
  });

  it('allows stage2 from url whitelist artifacts without a label whitelist match', () => {
    const result = buildStage2EnqueueDecision({
      runType: 'crawl_run',
      siteConfig: {
        seedUrls: ['https://example.com/docs/api'],
        sitemaps: [],
        rulesBeforeBaseEq: [],
        rulesBeforeStage2Eq: [
          {
            name: 'docs-url-artifact',
            matchType: 'url',
            listType: 'whitelist',
            ruleType: 'prefix',
            values: ['example.com/docs'],
            artifacts: ['markdown'],
          },
        ],
        runOptions: {
          seedMaxDepth: 1,
          crawlMaxDepth: 2,
        },
      },
      url: 'https://example.com/docs/api',
      classification: {
        labels: {
          content_type: ['other'],
        },
      },
    });

    expect(result).toEqual({
      ruleOutcome: 'allow',
      pageOutcome: 'allow',
      requiredArtifacts: ['markdown'],
      reason: null,
      pendingReason: null,
      matchedRuleNames: ['docs-url-artifact'],
    });
  });

  it('turns seed allow decisions into seed_run pending pages', () => {
    const result = buildStage2EnqueueDecision({
      runType: 'seed_run',
      siteConfig: {
        seedUrls: ['https://example.com/docs'],
        sitemaps: [],
        rulesBeforeBaseEq: [],
        rulesBeforeStage2Eq: [
          {
            name: 'docs-markdown',
            matchType: 'label',
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
          seedMaxDepth: 1,
          crawlMaxDepth: 2,
        },
      },
      url: 'https://example.com/docs',
      classification: {
        labels: {
          content_type: ['docs'],
        },
      },
    });

    expect(result).toEqual({
      ruleOutcome: 'allow',
      pageOutcome: 'pending',
      requiredArtifacts: ['markdown'],
      reason: null,
      pendingReason: 'seed_run',
      matchedRuleNames: ['docs-markdown'],
    });
  });

  it('allows base capture but denies stage2 with a url rule in the second execution point', () => {
    const siteConfig: SiteConfig = {
      seedUrls: ['https://example.com/blog/post'],
      sitemaps: [],
      rulesBeforeBaseEq: [
        {
          name: 'allow-site',
          matchType: 'url',
          listType: 'scopelist',
          ruleType: 'prefix',
          values: ['example.com'],
        },
      ],
      rulesBeforeStage2Eq: [
        {
          name: 'deny-blog-stage2',
          matchType: 'url',
          listType: 'blacklist',
          ruleType: 'prefix',
          values: ['example.com/blog'],
        },
        {
          name: 'allow-docs',
          matchType: 'label',
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
        seedMaxDepth: 1,
        crawlMaxDepth: 2,
      },
    };

    expect(
      buildBaseEnqueueDecision({
        url: 'https://example.com/blog/post',
        siteConfig,
      }),
    ).toEqual({
      enqueue: true,
      urlRuleDecision: 'allow',
      reason: null,
      matchedRuleNames: ['allow-site'],
    });

    expect(
      buildStage2EnqueueDecision({
        runType: 'crawl_run',
        url: 'https://example.com/blog/post',
        siteConfig,
        classification: {
          labels: {
            content_type: ['docs'],
          },
        },
      }),
    ).toEqual({
      ruleOutcome: 'deny',
      pageOutcome: 'deny',
      requiredArtifacts: [],
      reason: 'matched blacklist rule deny-blog-stage2',
      pendingReason: null,
      matchedRuleNames: ['deny-blog-stage2'],
    });
  });
});
