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
  SystemSettingRepository,
} from '../src/db/repositories/index.js';
import { SystemClock } from '../src/utils/clock.js';
import { createTempDir } from './helpers/tmp.js';

describe('repositories', () => {
  const openHandles: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const handle of openHandles) {
      await handle.close();
    }
    openHandles.length = 0;
  });

  it('prefers an explicit sqlite path over KVAULT_DATABASE_URL', async () => {
    const previousDatabaseUrl = process.env.KVAULT_DATABASE_URL;
    process.env.KVAULT_DATABASE_URL = 'postgres://user:password@example.invalid:5432/kvault';

    try {
      const dir = createTempDir('kvault-repos-env-');
      const db = await openDatabase({ path: join(dir, 'state.db') });
      openHandles.push(db);

      expect(db.dialect).toBe('sqlite');
      await initializeSchema(db);
    } finally {
      if (previousDatabaseUrl === undefined) {
        delete process.env.KVAULT_DATABASE_URL;
      } else {
        process.env.KVAULT_DATABASE_URL = previousDatabaseUrl;
      }
    }
  });

  it('persists the M1 business model and inventory read paths', async () => {
    const dir = createTempDir('kvault-repos-');
    const db = await openDatabase(join(dir, 'state.db'));
    openHandles.push(db);
    await initializeSchema(db);

    const clock = new SystemClock();
    const projects = new ProjectRepository(db, clock);
    const sites = new SiteRepository(db, clock);
    const runs = new RunRepository(db, clock);
    const pages = new SitePageRepository(db, clock);
    const pageRuns = new PageRunRepository(db, clock);
    const artifactRuns = new ArtifactRunRepository(db, clock);

    const project = await projects.create('Example Project');
    const site = await sites.create({
      projectId: project.id,
      name: 'example-site',
      baseUrl: 'https://example.com',
      storageRoot: dir,
      config: createDefaultSiteConfig('https://example.com/docs'),
    });
    const runId = await runs.createRun({
      siteId: site.id,
      runType: 'crawl_run',
      updatePolicy: 'force_recrawl_all',
      targetSuccessCount: null,
      configSnapshot: site.config,
    });
    const sitePageId = await pages.upsertDiscovery({
      siteId: site.id,
      discoveredUrl: 'https://example.com/docs',
      normalizedUrl: 'https://example.com/docs',
      discoverySource: 'seed_url',
      discoveryReferrerUrl: null,
      inventoryStatus: 'discovered_only',
      urlRuleDecision: 'allow',
    });

    const pageRunId = await pageRuns.create({
      runId,
      sitePageId,
      baseCaptureStatus: 'succeeded',
      baseCapturePath: '/tmp/base.md',
      title: 'Docs',
      metaDescription: 'Example docs',
      bodyText: 'hello docs',
      classificationLabels: {
        content_type: ['docs'],
      },
      ruleOutcome: 'allow',
      decisionOutcome: 'allow',
      decisionReason: null,
      pendingReason: null,
      requiredArtifacts: ['markdown', 'screenshot'],
    });

    await pages.recordBaseCapture({
      sitePageId,
      runId,
      title: 'Docs',
      pageOutcome: 'allow',
      requiredArtifacts: ['markdown', 'screenshot'],
      pendingReason: null,
    });

    const markdownArtifactRunId = await artifactRuns.create({
      runId,
      pageRunId,
      sitePageId,
      artifactType: 'markdown',
      status: 'succeeded',
      content: '# Docs',
      outputPath: null,
      errorMessage: null,
      meta: { tool: 'defuddle' },
    });

    await pages.recordArtifactResult({
      sitePageId,
      runId,
      artifactType: 'markdown',
      status: 'succeeded',
    });

    const screenshotArtifactRunId = await artifactRuns.create({
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

    await pages.recordArtifactResult({
      sitePageId,
      runId,
      artifactType: 'screenshot',
      status: 'succeeded',
    });

    expect(pageRunId).toBeGreaterThan(0);
    expect(markdownArtifactRunId).toBeGreaterThan(0);
    expect(screenshotArtifactRunId).toBeGreaterThan(0);
    expect(await pageRuns.countByRun(runId)).toBe(1);
    expect(await artifactRuns.countByRun(runId)).toBe(2);
    expect(await pages.summarizeInventory(site.id)).toEqual({
      totalPages: 1,
      pendingPages: 0,
      deniedPages: 0,
      capturedPages: 1,
    });
  });

  it('stores system URL normalization config with database defaults', async () => {
    const dir = createTempDir('kvault-system-settings-');
    const db = await openDatabase(join(dir, 'state.db'));
    openHandles.push(db);
    await initializeSchema(db);

    const settings = new SystemSettingRepository(db, new SystemClock());

    expect(await settings.getSystemConfig()).toEqual({
      urlNormalization: {
        stripQueryParams: ['wbraid', 'gbraid', 'ref'],
        stripQueryParamPrefixes: ['utm_'],
      },
    });

    await settings.setUrlNormalization({
      stripQueryParams: ['sessionId'],
      stripQueryParamPrefixes: ['preview_'],
    });

    expect(await settings.getSystemConfig()).toEqual({
      urlNormalization: {
        stripQueryParams: ['sessionId'],
        stripQueryParamPrefixes: ['preview_'],
      },
    });
  });

  it('tracks structured artifacts in inventory completion', async () => {
    const dir = createTempDir('kvault-repos-structured-');
    const db = await openDatabase(join(dir, 'state.db'));
    openHandles.push(db);
    await initializeSchema(db);

    const clock = new SystemClock();
    const projects = new ProjectRepository(db, clock);
    const sites = new SiteRepository(db, clock);
    const runs = new RunRepository(db, clock);
    const pages = new SitePageRepository(db, clock);
    const pageRuns = new PageRunRepository(db, clock);
    const artifactRuns = new ArtifactRunRepository(db, clock);

    const project = await projects.create('Structured Project');
    const site = await sites.create({
      projectId: project.id,
      name: 'structured-site',
      baseUrl: 'https://example.com',
      storageRoot: dir,
      config: createDefaultSiteConfig('https://example.com/docs'),
    });
    const runId = await runs.createRun({
      siteId: site.id,
      runType: 'crawl_run',
      updatePolicy: 'force_recrawl_all',
      targetSuccessCount: null,
      configSnapshot: site.config,
    });
    const sitePageId = await pages.upsertDiscovery({
      siteId: site.id,
      discoveredUrl: 'https://example.com/docs',
      normalizedUrl: 'https://example.com/docs',
      discoverySource: 'seed_url',
      discoveryReferrerUrl: null,
      inventoryStatus: 'discovered_only',
      urlRuleDecision: 'allow',
    });
    const pageRunId = await pageRuns.create({
      runId,
      sitePageId,
      baseCaptureStatus: 'succeeded',
      baseCapturePath: '/tmp/base.md',
      title: 'Docs',
      metaDescription: 'Example docs',
      bodyText: 'hello docs',
      classificationLabels: { content_type: ['docs'] },
      ruleOutcome: 'allow',
      decisionOutcome: 'allow',
      decisionReason: null,
      pendingReason: null,
      requiredArtifacts: ['structured'],
    });

    await pages.recordBaseCapture({
      sitePageId,
      runId,
      title: 'Docs',
      pageOutcome: 'allow',
      requiredArtifacts: ['structured'],
      pendingReason: null,
    });

    expect(await pages.summarizeInventory(site.id)).toEqual({
      totalPages: 1,
      pendingPages: 1,
      deniedPages: 0,
      capturedPages: 0,
    });

    await artifactRuns.create({
      runId,
      pageRunId,
      sitePageId,
      artifactType: 'structured',
      status: 'succeeded',
      content: '{"items":[]}',
      outputPath: '/tmp/structured.json',
      errorMessage: null,
      meta: null,
    });
    await pages.recordArtifactResult({
      sitePageId,
      runId,
      artifactType: 'structured',
      status: 'succeeded',
    });

    const history = await pages.getHistoricalState(site.id, 'https://example.com/docs');

    expect(history?.lastStructuredStatus).toBe('succeeded');
    expect(await pages.summarizeInventory(site.id)).toEqual({
      totalPages: 1,
      pendingPages: 0,
      deniedPages: 0,
      capturedPages: 1,
    });
  });
});
