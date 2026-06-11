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
});
