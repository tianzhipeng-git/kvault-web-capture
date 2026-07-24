import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseSiteConfig } from '../src/config/site-config.js';
import {
  expandArtifactRequirements,
  screenshotFingerprint,
} from '../src/domain/artifact-requirements.js';
import type { ScreenshotMetadata, SiteConfig } from '../src/domain/types.js';
import { ResultValidator } from '../src/capture/result-validator.js';
import { FileArtifactWriter } from '../src/export/file-artifact-writer.js';
import { initializeSchema, openDatabase } from '../src/db/database.js';
import {
  ArtifactRunRepository,
  SitePageRepository,
} from '../src/db/repositories/index.js';

function config(screenshot?: unknown): SiteConfig {
  return parseSiteConfig({
    seedUrls: ['https://example.com'],
    sitemaps: [],
    rulesBeforeBaseEq: [],
    rulesBeforeStage2Eq: [],
    runOptions: {},
    screenshot,
  });
}

describe('advanced screenshot configuration', () => {
  it('fills complete preparation defaults and expands stable variant requirements', () => {
    const siteConfig = config({
      mode: 'complete',
      variants: [
        {
          key: 'desktop-1440',
          device: 'desktop',
          viewport: { width: 1440, height: 900 },
        },
        { key: 'mobile-iphone-15', device: 'iPhone 15' },
      ],
    });

    expect(siteConfig.screenshot?.preparation).toMatchObject({
      waitForImages: true,
      scrollContainers: true,
      maxCaptureHeight: 50_000,
      onLimit: 'truncate',
    });
    const requirements = expandArtifactRequirements(
      ['markdown', 'screenshot'],
      siteConfig,
    );
    expect(requirements).toHaveLength(3);
    expect(requirements[0]).toEqual({
      artifactType: 'markdown',
      variantKey: 'default',
      configFingerprint: null,
    });
    expect(requirements.slice(1).map((item) => item.variantKey)).toEqual([
      'desktop-1440',
      'mobile-iphone-15',
    ]);
    expect(requirements[1].configFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes the fingerprint when effective preparation or viewport changes', () => {
    const first = config({
      mode: 'complete',
      variants: [{
        key: 'desktop',
        device: 'desktop',
        viewport: { width: 1440, height: 900 },
      }],
    }).screenshot!;
    const changed = config({
      mode: 'complete',
      preparation: { settleMs: 750 },
      variants: [{
        key: 'desktop',
        device: 'desktop',
        viewport: { width: 1440, height: 900 },
      }],
    }).screenshot!;

    expect(screenshotFingerprint(first, first.variants![0])).not.toBe(
      screenshotFingerprint(changed, changed.variants![0]),
    );
  });

  it('rejects duplicate, unsafe, unknown, and out-of-range variants', () => {
    expect(() => config({
      mode: 'complete',
      variants: [
        { key: '../desktop', device: 'desktop', viewport: { width: 1440, height: 900 } },
      ],
    })).toThrow(/key must match/);
    expect(() => config({
      mode: 'complete',
      variants: [
        { key: 'mobile', device: 'Unknown Phone' },
      ],
    })).toThrow(/supported Playwright device/);
    expect(() => config({
      mode: 'complete',
      variants: [
        { key: 'tiny', device: 'desktop', viewport: { width: 100, height: 900 } },
      ],
    })).toThrow(/viewport.width/);
  });
});

describe('advanced screenshot result contract', () => {
  const siteConfig = config({
    mode: 'complete',
    variants: [{
      key: 'desktop',
      device: 'desktop',
      viewport: { width: 1440, height: 900 },
    }],
  });
  const requirement = expandArtifactRequirements(['screenshot'], siteConfig)[0];
  const metadata: ScreenshotMetadata = {
    protocolVersion: 1,
    mode: 'complete',
    variantKey: requirement.variantKey,
    configFingerprint: requirement.configFingerprint!,
    device: 'desktop',
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    documentScrollCompleted: true,
    scrollContainersFound: 1,
    scrollContainersCompleted: 1,
    scrollContainersExpanded: 1,
    imagesFound: 2,
    imagesPending: 0,
    fontsReady: true,
    truncated: false,
    limitReason: null,
    preparationDurationMs: 100,
    captureWidth: 1440,
    captureHeight: 2000,
    warnings: [],
  };

  it('accepts matching metadata and rejects silent incomplete results', () => {
    const validator = new ResultValidator();
    expect(validator.validate({
      capability: 'screenshot',
      siteConfig,
      artifactRequirement: requirement,
      result: {
        toolName: 'fixture',
        screenshot: Buffer.from('png'),
        screenshotMetadata: metadata,
      },
    }).accepted).toBe(true);

    expect(validator.validate({
      capability: 'screenshot',
      siteConfig,
      artifactRequirement: requirement,
      result: {
        toolName: 'fixture',
        screenshot: Buffer.from('png'),
      },
    })).toMatchObject({
      accepted: false,
      message: 'complete screenshot metadata is missing',
    });
  });

  it('writes variants to isolated paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kvault-screenshot-'));
    const writer = new FileArtifactWriter(root);
    const written = await writer.writeBinaryArtifact({
      artifactType: 'screenshot',
      variantKey: 'desktop',
      runId: 1,
      sitePageId: 2,
      content: Buffer.from('png'),
      extension: 'png',
    });
    expect(written.outputPath).toBe(
      join(root, 'artifacts', 'run-1', 'page-2', 'screenshots', 'desktop.png'),
    );
    expect(readFileSync(written.outputPath).toString()).toBe('png');
  });

  it('marks the page captured only after every variant succeeds', async () => {
    const db = await openDatabase(':memory:');
    await initializeSchema(db);
    const now = '2026-07-24T00:00:00.000Z';
    const clock = { now: () => now };
    try {
      const project = await db.run(
        `INSERT INTO projects (name, slug, label_definitions_json, created_at)
         VALUES (?, ?, ?, ?)`,
        ['P', 'p', '{}', now],
      );
      const site = await db.run(
        `INSERT INTO sites (
           project_id, name, base_url, storage_root, config_json, updated_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [project.lastInsertId!, 'S', 'https://example.com', '/tmp', '{}', now, now],
      );
      const run = await db.run(
        `INSERT INTO crawl_runs (
           site_id, run_type, update_policy, config_snapshot_json, status, started_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [site.lastInsertId!, 'crawl_run', 'force_recrawl_all', '{}', 'running', now],
      );
      const page = await db.run(
        `INSERT INTO site_pages (
           site_id, discovered_url, normalized_url, inventory_status,
           discovery_source, last_stage_decision_json, first_discovered_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          site.lastInsertId!,
          'https://example.com',
          'https://example.com',
          'stage2_pending',
          'test',
          JSON.stringify({ outcome: 'allow', requiredArtifacts: ['screenshot'] }),
          now,
          now,
          now,
        ],
      );
      const requirements = expandArtifactRequirements(['screenshot'], siteConfig);
      const pageRun = await db.run(
        `INSERT INTO page_runs (
           crawl_run_id, site_page_id, started_at, finished_at,
           base_capture_status, title, meta_description, body_text,
           classification_labels_json, rule_outcome, decision_outcome,
           required_artifacts_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          run.lastInsertId!,
          page.lastInsertId!,
          now,
          now,
          'succeeded',
          '',
          '',
          '',
          '{}',
          'allow',
          'allow',
          JSON.stringify([
            requirements[0],
            { ...requirements[0], variantKey: 'mobile', configFingerprint: 'b'.repeat(64) },
          ]),
        ],
      );
      const artifactRuns = new ArtifactRunRepository(db, clock);
      const sitePages = new SitePageRepository(db, clock);
      for (const requirement of [
        requirements[0],
        { ...requirements[0], variantKey: 'mobile', configFingerprint: 'b'.repeat(64) },
      ]) {
        await artifactRuns.create({
          runId: run.lastInsertId!,
          pageRunId: pageRun.lastInsertId!,
          sitePageId: page.lastInsertId!,
          artifactType: 'screenshot',
          variantKey: requirement.variantKey,
          configFingerprint: requirement.configFingerprint,
          status: 'succeeded',
          content: null,
          outputPath: '/tmp/screenshot.png',
          errorMessage: null,
          meta: {},
        });
        await sitePages.recordArtifactResult({
          sitePageId: page.lastInsertId!,
          runId: run.lastInsertId!,
          pageRunId: pageRun.lastInsertId!,
          artifactType: 'screenshot',
          status: 'succeeded',
        });
        const state = await db.get<{
          last_screenshot_status: string | null;
          inventory_status: string;
        }>(
          'SELECT last_screenshot_status, inventory_status FROM site_pages WHERE id = ?',
          [page.lastInsertId!],
        );
        if (requirement.variantKey === requirements[0].variantKey) {
          expect(state).toEqual({
            last_screenshot_status: null,
            inventory_status: 'stage2_pending',
          });
        } else {
          expect(state).toEqual({
            last_screenshot_status: 'succeeded',
            inventory_status: 'stage2_captured',
          });
        }
      }
    } finally {
      await db.close();
    }
  });
});
