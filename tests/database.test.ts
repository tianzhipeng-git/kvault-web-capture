import { describe, expect, it } from 'vitest';

import { openDatabase, initializeSchema, type DbClient, type DbValue } from '../src/db/database.js';

class RecordingPostgresDb implements DbClient {
  readonly dialect = 'postgres' as const;
  readonly statements: string[] = [];
  private hasLastStructuredAt = false;
  private latestHandledIndexIncludesLastStructuredAt = false;

  get hasLatestHandledIndexWithLastStructuredAt(): boolean {
    return this.latestHandledIndexIncludesLastStructuredAt;
  }

  async exec(sql: string): Promise<void> {
    if (
      !this.hasLastStructuredAt &&
      /CREATE INDEX IF NOT EXISTS idx_site_pages_site_latest_handled/.test(sql) &&
      /last_structured_at/.test(sql)
    ) {
      throw new Error('column "last_structured_at" does not exist');
    }

    this.statements.push(sql);
    if (/ALTER TABLE site_pages ADD COLUMN IF NOT EXISTS last_structured_at TEXT/.test(sql)) {
      this.hasLastStructuredAt = true;
    }
    if (/DROP INDEX IF EXISTS idx_site_pages_site_latest_handled/.test(sql)) {
      this.latestHandledIndexIncludesLastStructuredAt = false;
    }
    if (/CREATE INDEX IF NOT EXISTS idx_site_pages_site_latest_handled/.test(sql)) {
      this.latestHandledIndexIncludesLastStructuredAt = /last_structured_at/.test(sql);
    }
  }

  async get<T>(): Promise<T | undefined> {
    return undefined;
  }

  async all<T>(): Promise<T[]> {
    return [];
  }

  async run(_sql: string, _params: readonly DbValue[] = []) {
    return { lastInsertId: null, changes: null };
  }

  async close(): Promise<void> {}
}

describe('initializeSchema', () => {
  it('runs compatibility migrations before indexes that reference new columns', async () => {
    const db = new RecordingPostgresDb();

    await initializeSchema(db);

    const lastStructuredMigrationIndex = db.statements.findIndex((sql) =>
      /ALTER TABLE site_pages ADD COLUMN IF NOT EXISTS last_structured_at TEXT/.test(sql),
    );
    const latestHandledIndexIndex = db.statements.findIndex((sql) =>
      /CREATE INDEX IF NOT EXISTS idx_site_pages_site_latest_handled/.test(sql),
    );

    expect(lastStructuredMigrationIndex).toBeGreaterThan(-1);
    expect(latestHandledIndexIndex).toBeGreaterThan(-1);
    expect(lastStructuredMigrationIndex).toBeLessThan(latestHandledIndexIndex);
  });

  it('rebuilds changed indexes instead of keeping the existing definition', async () => {
    const db = new RecordingPostgresDb();

    await initializeSchema(db);

    const dropIndexIndex = db.statements.findIndex((sql) =>
      /DROP INDEX IF EXISTS idx_site_pages_site_latest_handled/.test(sql),
    );
    const createIndexIndex = db.statements.findIndex((sql) =>
      /CREATE INDEX IF NOT EXISTS idx_site_pages_site_latest_handled/.test(sql),
    );

    expect(dropIndexIndex).toBeGreaterThan(-1);
    expect(createIndexIndex).toBeGreaterThan(-1);
    expect(dropIndexIndex).toBeLessThan(createIndexIndex);
    expect(db.hasLatestHandledIndexWithLastStructuredAt).toBe(true);
  });

  it('migrates stored site configs and run snapshots to a single captureProfile', async () => {
    const db = await openDatabase(':memory:');
    await initializeSchema(db);
    await db.run(
      `INSERT INTO projects (name, slug, label_definitions_json, created_at)
       VALUES (?, ?, ?, ?)`,
      ['Project', 'project', '[]', '2026-06-11T00:00:00.000Z'],
    );
    await db.run(
      `INSERT INTO sites (
         project_id, name, base_url, storage_root, config_json, updated_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        1,
        'Site',
        'https://example.com',
        '.local/site',
        JSON.stringify({
          seedUrls: [],
          captureProfiles: {
            default: { tools: ['http-base'] },
            browser: {
              tools: ['crawl4ai-page'],
              validation: {
                markdown: {
                  minLength: 500,
                  rejectRegex: ['profile-blocked'],
                },
              },
            },
          },
          defaultCaptureProfile: 'browser',
          validation: {
            markdown: {
              minLength: 100,
              rejectRegex: ['site-blocked'],
              requireRegex: ['content'],
            },
          },
        }),
        '2026-06-11T00:00:00.000Z',
        '2026-06-11T00:00:00.000Z',
      ],
    );
    await db.run(
      `INSERT INTO crawl_runs (
         site_id, run_type, update_policy, config_snapshot_json, status, started_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        1,
        'crawl_run',
        'force_recrawl_all',
        JSON.stringify({
          seedUrls: [],
          captureProfiles: { default: { tools: ['defuddle-markdown'] } },
        }),
        'succeeded',
        '2026-06-11T00:00:00.000Z',
      ],
    );

    await initializeSchema(db);

    const site = await db.get<{ config_json: string }>('SELECT config_json FROM sites WHERE id = 1');
    const run = await db.get<{ config_snapshot_json: string }>(
      'SELECT config_snapshot_json FROM crawl_runs WHERE id = 1',
    );

    expect(JSON.parse(site!.config_json)).toEqual({
      seedUrls: [],
      captureProfile: { tools: ['crawl4ai-page'] },
      validation: {
        markdown: {
          minLength: 500,
          rejectRegex: ['site-blocked', 'profile-blocked'],
          requireRegex: ['content'],
        },
      },
    });
    expect(JSON.parse(run!.config_snapshot_json)).toEqual({
      seedUrls: [],
      captureProfile: { tools: ['defuddle-markdown'] },
    });

    await db.close();
  });

  it('migrates stage decisions and page runs to requirement snapshots', async () => {
    const db = await openDatabase(':memory:');
    await initializeSchema(db);
    const now = '2026-07-24T00:00:00.000Z';
    await db.run(
      'INSERT INTO projects (name, slug, label_definitions_json, created_at) VALUES (?, ?, ?, ?)',
      ['Project', 'requirement-migration', '[]', now],
    );
    await db.run(
      `INSERT INTO sites (project_id, name, base_url, storage_root, config_json, updated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [1, 'Site', 'https://example.com', '.local/site', '{}', now, now],
    );
    await db.run(
      `INSERT INTO site_pages (
         site_id, discovered_url, normalized_url, inventory_status, discovery_source,
         last_stage_decision_json, first_discovered_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [1, 'https://example.com', 'https://example.com', 'stage2_pending', 'test', JSON.stringify({ outcome: 'allow', requiredArtifacts: ['screenshot'] }), now, now, now],
    );
    await db.run(
      `INSERT INTO crawl_runs (site_id, run_type, update_policy, config_snapshot_json, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [1, 'crawl_run', 'skip_existing', '{}', 'succeeded', now],
    );
    await db.run(
      `INSERT INTO page_runs (
         crawl_run_id, site_page_id, started_at, finished_at, base_capture_status,
         title, meta_description, body_text, classification_labels_json, rule_outcome,
         decision_outcome, required_artifacts_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [1, 1, now, now, 'succeeded', '', '', '', '{}', 'allow', 'allow', JSON.stringify(['screenshot'])],
    );

    await initializeSchema(db);

    const page = await db.get<{ last_stage_decision_json: string }>(
      'SELECT last_stage_decision_json FROM site_pages WHERE id = 1',
    );
    const pageRun = await db.get<{ required_artifacts_json: string }>(
      'SELECT required_artifacts_json FROM page_runs WHERE id = 1',
    );
    const requirement = {
      artifactType: 'screenshot',
      variantKey: 'default',
      configFingerprint: null,
    };
    expect(JSON.parse(page!.last_stage_decision_json)).toEqual({
      outcome: 'allow',
      requiredArtifacts: [requirement],
    });
    expect(JSON.parse(pageRun!.required_artifacts_json)).toEqual([requirement]);
    await db.close();
  });
});
