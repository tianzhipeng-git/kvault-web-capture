import { describe, expect, it } from 'vitest';

import type { CaptureTool } from '../src/capture/types.js';
import type { SiteConfig } from '../src/domain/types.js';
import { createDefaultSiteConfig } from '../src/config/site-config.js';
import {
  filterIntegratedEagerArtifacts,
  resolveBaseTaskNeeds,
  resolveProspectiveArtifacts,
} from '../src/planner/base-task-needs.js';

const integratedTool: CaptureTool = {
  name: 'scrapling-page',
  capabilities: ['base', 'markdown', 'screenshot', 'structured'],
  async capture() {
    throw new Error('not used');
  },
};

const splitTools: CaptureTool[] = [
  {
    name: 'http-base',
    capabilities: ['base'],
    async capture() {
      throw new Error('not used');
    },
  },
  {
    name: 'defuddle-markdown',
    capabilities: ['markdown'],
    async capture() {
      throw new Error('not used');
    },
  },
];

describe('base task needs', () => {
  it('includes URL rule artifacts for crawl_run when profile has integrated tools', () => {
    const siteConfig: SiteConfig = {
      ...createDefaultSiteConfig('https://example.com'),
      rulesBeforeStage2Eq: [
        {
          name: 'capture-all',
          matchType: 'url',
          listType: 'whitelist',
          ruleType: 'regex',
          values: ['.*'],
          artifacts: ['markdown', 'screenshot', 'structured'],
        },
      ],
      captureProfile: {
        tools: ['scrapling-page'],
      },
    };

    expect(resolveProspectiveArtifacts({
      url: 'https://example.com/docs',
      siteConfig,
    })).toEqual(['markdown', 'screenshot', 'structured']);

    expect(resolveBaseTaskNeeds({
      url: 'https://example.com/docs',
      siteConfig,
      runType: 'crawl_run',
      updatePolicy: 'force_recrawl_all',
      history: null,
      staleAfterMs: null,
      nowIsoString: '2026-01-01T00:00:00.000Z',
      captureTools: [integratedTool],
    })).toEqual(['base', 'markdown', 'screenshot', 'structured']);
  });

  it('does not eager-fetch artifacts for split tool chains', () => {
    const siteConfig: SiteConfig = {
      ...createDefaultSiteConfig('https://example.com'),
      rulesBeforeStage2Eq: [
        {
          name: 'capture-all',
          matchType: 'url',
          listType: 'whitelist',
          ruleType: 'regex',
          values: ['.*'],
          artifacts: ['markdown', 'screenshot'],
        },
      ],
    };

    expect(filterIntegratedEagerArtifacts({
      prospectiveArtifacts: ['markdown', 'screenshot'],
      siteConfig,
      captureTools: splitTools,
    })).toEqual([]);

    expect(resolveBaseTaskNeeds({
      url: 'https://example.com/docs',
      siteConfig,
      runType: 'crawl_run',
      updatePolicy: 'force_recrawl_all',
      history: null,
      staleAfterMs: null,
      nowIsoString: '2026-01-01T00:00:00.000Z',
      captureTools: splitTools,
    })).toEqual(['base']);
  });

  it('includes label whitelist artifacts when integrated tools cover them', () => {
    const siteConfig: SiteConfig = {
      ...createDefaultSiteConfig('https://example.com'),
      captureProfile: {
        tools: ['scrapling-page'],
      },
    };

    expect(resolveBaseTaskNeeds({
      url: 'https://example.com/docs',
      siteConfig,
      runType: 'crawl_run',
      updatePolicy: 'force_recrawl_all',
      history: null,
      staleAfterMs: null,
      nowIsoString: '2026-01-01T00:00:00.000Z',
      captureTools: [integratedTool],
    })).toEqual(['base', 'markdown']);
  });

  it('returns only base for seed_run', () => {
    const siteConfig: SiteConfig = {
      ...createDefaultSiteConfig('https://example.com'),
      rulesBeforeStage2Eq: [
        {
          name: 'capture-all',
          matchType: 'url',
          listType: 'whitelist',
          ruleType: 'regex',
          values: ['.*'],
          artifacts: ['markdown', 'screenshot'],
        },
      ],
    };

    expect(resolveBaseTaskNeeds({
      url: 'https://example.com/docs',
      siteConfig,
      runType: 'seed_run',
      updatePolicy: 'force_recrawl_all',
      history: null,
      staleAfterMs: null,
      nowIsoString: '2026-01-01T00:00:00.000Z',
      captureTools: [integratedTool],
    })).toEqual(['base']);
  });

  it('respects update policy when deciding eager artifact needs', () => {
    const siteConfig: SiteConfig = {
      ...createDefaultSiteConfig('https://example.com'),
      captureProfile: {
        tools: ['scrapling-page'],
      },
    };

    expect(resolveBaseTaskNeeds({
      url: 'https://example.com/docs',
      siteConfig,
      runType: 'crawl_run',
      updatePolicy: 'skip_existing',
      history: {
        sitePageId: 1,
        normalizedUrl: 'https://example.com/docs',
        inventoryStatus: 'stage2_captured',
        lastBaseStatus: 'succeeded',
        lastBaseAt: '2026-01-01T00:00:00.000Z',
        latestClassificationLabels: { content_type: ['docs'] },
        lastStageDecision: {
          outcome: 'allow',
          requiredArtifacts: ['markdown'],
        },
        lastMarkdownStatus: 'succeeded',
        lastMarkdownAt: '2026-01-01T00:00:00.000Z',
        lastScreenshotStatus: null,
        lastScreenshotAt: null,
        lastStructuredStatus: null,
        lastStructuredAt: null,
      },
      staleAfterMs: null,
      nowIsoString: '2026-01-01T00:00:00.000Z',
      captureTools: [integratedTool],
    })).toEqual(['base']);
  });
});
