import { describe, expect, it } from 'vitest';

import { initializeSchema, type DbClient, type DbValue } from '../src/db/database.js';

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
});
