import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase, type DbClient } from '../src/db/database.js';
import { createWebServer } from '../src/web/server.js';
import { createTempDir } from './helpers/tmp.js';

const config = {
  seedUrls: [],
  sitemaps: [],
  rulesBeforeBaseEq: [],
  rulesBeforeStage2Eq: [],
  runOptions: {
    seedMaxDepth: 1,
    crawlMaxDepth: 1,
  },
};

async function insertPage(db: DbClient, input: {
  siteId: number;
  runId: number;
  suffix: string;
  baseStatus: 'succeeded' | 'failed';
  outcome: 'allow' | 'pending' | 'deny';
  requiredArtifacts?: string[];
}): Promise<{ sitePageId: number; pageRunId: number }> {
  const now = new Date().toISOString();
  const url = `https://example.com/${input.suffix}`;
  const page = await db.run(
    `INSERT INTO site_pages (
      site_id, discovered_url, normalized_url, inventory_status, discovery_source,
      first_discovered_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.siteId, url, url, 'candidate', 'seed', now, now, now],
  );
  const pageRun = await db.run(
    `INSERT INTO page_runs (
      crawl_run_id, site_page_id, started_at, finished_at, base_capture_status,
      title, meta_description, body_text, classification_labels_json, rule_outcome,
      decision_outcome, required_artifacts_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.runId,
      page.lastInsertId,
      now,
      now,
      input.baseStatus,
      input.suffix,
      '',
      '',
      '{}',
      input.outcome,
      input.outcome,
      JSON.stringify(input.requiredArtifacts ?? []),
    ],
  );

  return {
    sitePageId: Number(page.lastInsertId),
    pageRunId: Number(pageRun.lastInsertId),
  };
}

describe('live run progress', () => {
  const servers: Array<Awaited<ReturnType<typeof createWebServer>>> = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()!.close();
    }
  });

  it('returns current page and artifact outcomes while the persisted summary is stale', async () => {
    const dir = createTempDir('kvault-live-progress-');
    const dbPath = join(dir, 'state.db');
    const server = await createWebServer({
      dbPath,
      adminPassword: 'secret',
      apiKey: 'external-secret',
    });
    servers.push(server);

    const db = await openDatabase(dbPath);
    const now = new Date().toISOString();
    const project = await db.run(
      'INSERT INTO projects (name, slug, label_definitions_json, created_at) VALUES (?, ?, ?, ?)',
      ['Progress', 'progress', '[]', now],
    );
    const site = await db.run(
      `INSERT INTO sites (
        project_id, name, base_url, storage_root, config_json, updated_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [project.lastInsertId, 'site', 'https://example.com', dir, JSON.stringify(config), now, now],
    );
    const run = await db.run(
      `INSERT INTO crawl_runs (
        site_id, run_type, update_policy, config_snapshot_json, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [site.lastInsertId, 'crawl_run', 'force_recrawl_all', JSON.stringify(config), 'running', now],
    );
    const succeededPage = await insertPage(db, {
      siteId: Number(site.lastInsertId),
      runId: Number(run.lastInsertId),
      suffix: 'succeeded',
      baseStatus: 'succeeded',
      outcome: 'allow',
      requiredArtifacts: ['markdown'],
    });
    const failedArtifactPage = await insertPage(db, {
      siteId: Number(site.lastInsertId),
      runId: Number(run.lastInsertId),
      suffix: 'failed-artifact',
      baseStatus: 'succeeded',
      outcome: 'allow',
      requiredArtifacts: ['screenshot'],
    });
    await insertPage(db, {
      siteId: Number(site.lastInsertId),
      runId: Number(run.lastInsertId),
      suffix: 'failed-base',
      baseStatus: 'failed',
      outcome: 'deny',
    });
    await insertPage(db, {
      siteId: Number(site.lastInsertId),
      runId: Number(run.lastInsertId),
      suffix: 'pending',
      baseStatus: 'succeeded',
      outcome: 'pending',
    });
    await insertPage(db, {
      siteId: Number(site.lastInsertId),
      runId: Number(run.lastInsertId),
      suffix: 'denied',
      baseStatus: 'succeeded',
      outcome: 'deny',
    });

    for (const [page, artifactType, status] of [
      [succeededPage, 'markdown', 'succeeded'],
      [failedArtifactPage, 'screenshot', 'failed'],
    ] as const) {
      await db.run(
        `INSERT INTO artifact_runs (
          crawl_run_id, page_run_id, site_page_id, artifact_type, status,
          started_at, finished_at, content
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [run.lastInsertId, page.pageRunId, page.sitePageId, artifactType, status, now, now, null],
      );
    }

    const response = await server.inject({
      method: 'GET',
      url: `/api/simple-capture/runs/${run.lastInsertId}`,
      headers: { 'x-api-key': 'external-secret' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      statusLabel: '进行中',
      successfulPages: 1,
      failedPages: 2,
      pendingPages: 1,
      deniedPages: 1,
      successfulArtifacts: 1,
      failedArtifacts: 1,
    });
    await db.close();
  });
});
