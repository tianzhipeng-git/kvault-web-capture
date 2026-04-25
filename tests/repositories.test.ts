import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultSiteConfig } from '../src/config/site-config.js';
import { initializeSchema, openDatabase } from '../src/db/database.js';
import {
  ArtifactRunRepository,
  PageRunRepository,
  ProjectRepository,
  RunRepository,
  SitePageRepository,
  SiteRepository,
} from '../src/db/repositories/index.js';
import { SystemClock } from '../src/utils/clock.js';
import { createTempDir } from './helpers/tmp.js';

describe('repositories', () => {
  const openHandles: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const handle of openHandles) {
      handle.close();
    }
    openHandles.length = 0;
  });

  it('persists the M1 business model and inventory read paths', () => {
    const dir = createTempDir('kvault-repos-');
    const db = openDatabase(join(dir, 'state.db'));
    openHandles.push(db);
    initializeSchema(db);

    const clock = new SystemClock();
    const projects = new ProjectRepository(db, clock);
    const sites = new SiteRepository(db, clock);
    const runs = new RunRepository(db, clock);
    const pages = new SitePageRepository(db, clock);
    const pageRuns = new PageRunRepository(db, clock);
    const artifactRuns = new ArtifactRunRepository(db, clock);

    const project = projects.create('Example Project');
    const site = sites.create({
      projectId: project.id,
      name: 'example-site',
      baseUrl: 'https://example.com',
      storageRoot: dir,
      config: createDefaultSiteConfig('https://example.com/docs'),
    });
    const runId = runs.createRun({
      siteId: site.id,
      runType: 'crawl_run',
      updatePolicy: 'force_recrawl_all',
      targetSuccessCount: null,
      configSnapshot: site.config,
    });
    const sitePageId = pages.upsertDiscovery({
      siteId: site.id,
      discoveredUrl: 'https://example.com/docs',
      normalizedUrl: 'https://example.com/docs',
      discoverySource: 'seed_url',
      discoveryReferrerUrl: null,
      inventoryStatus: 'discovered_only',
      urlRuleDecision: 'allow',
    });

    const pageRunId = pageRuns.create({
      runId,
      sitePageId,
      baseCaptureStatus: 'succeeded',
      baseCapturePath: '/tmp/base.md',
      title: 'Docs',
      metaDescription: 'Example docs',
      bodyText: 'hello docs',
      classificationTags: {
        content_type: ['docs'],
      },
      ruleOutcome: 'allow',
      decisionOutcome: 'allow',
      decisionReason: null,
      pendingReason: null,
      requiredArtifacts: ['markdown', 'screenshot'],
    });

    pages.recordBaseCapture({
      sitePageId,
      runId,
      title: 'Docs',
      pageOutcome: 'allow',
      requiredArtifacts: ['markdown', 'screenshot'],
      pendingReason: null,
    });

    const markdownArtifactRunId = artifactRuns.create({
      runId,
      pageRunId,
      sitePageId,
      artifactType: 'markdown',
      status: 'succeeded',
      content: '# Docs',
      outputPath: null,
      errorMessage: null,
      meta: { strategy: 'defuddle' },
    });

    pages.recordArtifactResult({
      sitePageId,
      runId,
      artifactType: 'markdown',
      status: 'succeeded',
    });

    const screenshotArtifactRunId = artifactRuns.create({
      runId,
      pageRunId,
      sitePageId,
      artifactType: 'screenshot',
      status: 'succeeded',
      content: null,
      outputPath: '/tmp/fake.png',
      errorMessage: null,
      meta: { tool: 'playwright' },
    });

    pages.recordArtifactResult({
      sitePageId,
      runId,
      artifactType: 'screenshot',
      status: 'succeeded',
    });

    expect(pageRunId).toBeGreaterThan(0);
    expect(markdownArtifactRunId).toBeGreaterThan(0);
    expect(screenshotArtifactRunId).toBeGreaterThan(0);
    expect(pageRuns.countByRun(runId)).toBe(1);
    expect(artifactRuns.countByRun(runId)).toBe(2);
    expect(pages.summarizeInventory(site.id)).toEqual({
      totalPages: 1,
      pendingPages: 0,
      deniedPages: 0,
      capturedPages: 1,
    });
  });
});
