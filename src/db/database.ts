import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import pg from 'pg';

const { Pool, types } = pg;

types.setTypeParser(20, (value) => Number(value));
types.setTypeParser(1700, (value) => Number(value));

export type DbDialect = 'sqlite' | 'postgres';

export type DbValue = string | number | bigint | null | Buffer;

export interface DbRunResult {
  lastInsertId: number | null;
  changes: number | null;
}

export interface DbClient {
  readonly dialect: DbDialect;
  exec(sql: string): Promise<void>;
  get<T>(sql: string, params?: readonly DbValue[]): Promise<T | undefined>;
  all<T>(sql: string, params?: readonly DbValue[]): Promise<T[]>;
  run(sql: string, params?: readonly DbValue[]): Promise<DbRunResult>;
  close(): Promise<void>;
}

export interface OpenDatabaseOptions {
  path?: string;
  url?: string;
  dialect?: DbDialect;
}

function postgresSql(sql: string): string {
  let index = 0;

  return sql.replace(/'(?:''|[^'])*'|\?/g, (token) => {
    if (token !== '?') {
      return token;
    }

    index += 1;
    return `$${index}`;
  });
}

function postgresRunSql(sql: string): string {
  const converted = postgresSql(sql);
  if (
    /^\s*INSERT\b/i.test(converted) &&
    !/\bRETURNING\b/i.test(converted) &&
    !/\bON\s+CONFLICT\b/i.test(converted)
  ) {
    return `${converted.replace(/;\s*$/, '')} RETURNING id`;
  }
  return converted;
}

class SqliteDbClient implements DbClient {
  readonly dialect = 'sqlite' as const;

  constructor(private readonly db: DatabaseSync) {}

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async get<T>(
    sql: string,
    params: readonly DbValue[] = [],
  ): Promise<T | undefined> {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  async all<T>(
    sql: string,
    params: readonly DbValue[] = [],
  ): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async run(sql: string, params: readonly DbValue[] = []): Promise<DbRunResult> {
    const result = this.db.prepare(sql).run(...params);
    return {
      lastInsertId: Number(result.lastInsertRowid),
      changes: Number(result.changes),
    };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

class PostgresDbClient implements DbClient {
  readonly dialect = 'postgres' as const;

  constructor(private readonly pool: pg.Pool) {}

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async get<T>(
    sql: string,
    params: readonly DbValue[] = [],
  ): Promise<T | undefined> {
    const result = await this.pool.query(postgresSql(sql), [...params]);
    return result.rows[0] as T | undefined;
  }

  async all<T>(
    sql: string,
    params: readonly DbValue[] = [],
  ): Promise<T[]> {
    const result = await this.pool.query(postgresSql(sql), [...params]);
    return result.rows as T[];
  }

  async run(sql: string, params: readonly DbValue[] = []): Promise<DbRunResult> {
    const result = await this.pool.query<Record<string, unknown>>(postgresRunSql(sql), [...params]);
    const insertedId = result.rows[0]?.id;
    return {
      lastInsertId: insertedId === undefined ? null : Number(insertedId),
      changes: result.rowCount,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export async function openDatabase(options: string | OpenDatabaseOptions): Promise<DbClient> {
  const normalized = typeof options === 'string' ? { path: options } : options;
  const explicitPath = normalized.path;
  const explicitUrl = typeof options === 'string' ? undefined : normalized.url;
  const url =
    explicitUrl ??
    (normalized.dialect === 'postgres' || !explicitPath ? process.env.KVAULT_DATABASE_URL : undefined);
  const dialect =
    normalized.dialect ??
    (url && /^postgres(?:ql)?:\/\//i.test(url) ? 'postgres' : 'sqlite');

  if (dialect === 'postgres') {
    if (!url) {
      throw new Error('PostgreSQL requires KVAULT_DATABASE_URL or openDatabase({ url })');
    }

    return new PostgresDbClient(new Pool({ connectionString: url }));
  }

  const databasePath = normalized.path ?? process.env.KVAULT_DB_PATH ?? '.local/state.db';
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON');
  return new SqliteDbClient(db);
}

const baseTablesSchema = `
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    label_definitions_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    storage_root TEXT NOT NULL,
    config_json TEXT NOT NULL,
    favicon_data BLOB,
    favicon_content_type TEXT,
    favicon_updated_at TEXT,
    updated_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_project_name
    ON sites(project_id, name);

  CREATE TABLE IF NOT EXISTS crawl_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    run_type TEXT NOT NULL,
    update_policy TEXT NOT NULL,
    target_success_count INTEGER,
    successful_page_count INTEGER NOT NULL DEFAULT 0,
    candidate_page_count INTEGER NOT NULL DEFAULT 0,
    pending_page_count INTEGER NOT NULL DEFAULT 0,
    denied_page_count INTEGER NOT NULL DEFAULT 0,
    config_snapshot_json TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    FOREIGN KEY (site_id) REFERENCES sites(id)
  );

  CREATE TABLE IF NOT EXISTS site_pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    discovered_url TEXT NOT NULL,
    normalized_url TEXT NOT NULL,
    inventory_status TEXT NOT NULL,
    discovery_source TEXT NOT NULL,
    discovery_referrer_url TEXT,
    last_url_rule_decision TEXT,
    last_stage_decision_json TEXT,
    last_pending_reason TEXT,
    latest_title TEXT,
    last_base_status TEXT,
    last_base_run_id INTEGER,
    last_base_at TEXT,
    last_markdown_status TEXT,
    last_markdown_run_id INTEGER,
    last_markdown_at TEXT,
    last_screenshot_status TEXT,
    last_screenshot_run_id INTEGER,
    last_screenshot_at TEXT,
    last_structured_status TEXT,
    last_structured_run_id INTEGER,
    last_structured_at TEXT,
    first_discovered_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(site_id, normalized_url),
    FOREIGN KEY (site_id) REFERENCES sites(id),
    FOREIGN KEY (last_base_run_id) REFERENCES crawl_runs(id),
    FOREIGN KEY (last_markdown_run_id) REFERENCES crawl_runs(id),
    FOREIGN KEY (last_screenshot_run_id) REFERENCES crawl_runs(id),
    FOREIGN KEY (last_structured_run_id) REFERENCES crawl_runs(id)
  );

  CREATE TABLE IF NOT EXISTS page_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    crawl_run_id INTEGER NOT NULL,
    site_page_id INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    base_capture_status TEXT NOT NULL,
    base_capture_path TEXT,
    title TEXT NOT NULL,
    meta_description TEXT NOT NULL,
    body_text TEXT NOT NULL,
    classification_labels_json TEXT NOT NULL,
    rule_outcome TEXT NOT NULL,
    decision_outcome TEXT NOT NULL,
    decision_reason TEXT,
    pending_reason TEXT,
    required_artifacts_json TEXT NOT NULL,
    FOREIGN KEY (crawl_run_id) REFERENCES crawl_runs(id),
    FOREIGN KEY (site_page_id) REFERENCES site_pages(id)
  );

  CREATE TABLE IF NOT EXISTS artifact_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    crawl_run_id INTEGER NOT NULL,
    page_run_id INTEGER NOT NULL,
    site_page_id INTEGER NOT NULL,
    artifact_type TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    output_path TEXT,
    content TEXT,
    error_message TEXT,
    meta_json TEXT,
    FOREIGN KEY (crawl_run_id) REFERENCES crawl_runs(id),
    FOREIGN KEY (page_run_id) REFERENCES page_runs(id),
    FOREIGN KEY (site_page_id) REFERENCES site_pages(id)
  );

  CREATE TABLE IF NOT EXISTS run_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    crawl_run_id INTEGER NOT NULL,
    level TEXT NOT NULL,
    event TEXT NOT NULL,
    url TEXT,
    site_page_id INTEGER,
    page_run_id INTEGER,
    message TEXT NOT NULL,
    meta_json TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (crawl_run_id) REFERENCES crawl_runs(id)
  );

  CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const indexesSchema = `
  CREATE INDEX IF NOT EXISTS idx_site_pages_site_inventory
    ON site_pages(site_id, inventory_status);

  CREATE INDEX IF NOT EXISTS idx_site_pages_site_latest_handled
    ON site_pages(site_id, (COALESCE(last_markdown_at, last_screenshot_at, last_structured_at, last_base_at)) DESC, id DESC);

  CREATE INDEX IF NOT EXISTS idx_page_runs_run
    ON page_runs(crawl_run_id);

  CREATE INDEX IF NOT EXISTS idx_page_runs_site_page_latest
    ON page_runs(site_page_id, id DESC);

  CREATE INDEX IF NOT EXISTS idx_page_runs_site_page_run
    ON page_runs(site_page_id, crawl_run_id);

  CREATE INDEX IF NOT EXISTS idx_artifact_runs_run
    ON artifact_runs(crawl_run_id);

  CREATE INDEX IF NOT EXISTS idx_artifact_runs_site_page_run
    ON artifact_runs(site_page_id, crawl_run_id);

  CREATE INDEX IF NOT EXISTS idx_run_logs_run
    ON run_logs(crawl_run_id);
`;

const postgresTablesSchema = baseTablesSchema.replaceAll(
  'INTEGER PRIMARY KEY AUTOINCREMENT',
  'SERIAL PRIMARY KEY',
).replaceAll('BLOB', 'BYTEA');

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeValidationRule(
  siteRule: unknown,
  profileRule: unknown,
): Record<string, unknown> | undefined {
  if (!isJsonObject(siteRule) && !isJsonObject(profileRule)) {
    return undefined;
  }

  const site = isJsonObject(siteRule) ? siteRule : {};
  const profile = isJsonObject(profileRule) ? profileRule : {};
  return {
    ...site,
    ...profile,
    rejectRegex: [
      ...(Array.isArray(site.rejectRegex) ? site.rejectRegex : []),
      ...(Array.isArray(profile.rejectRegex) ? profile.rejectRegex : []),
    ],
    requireRegex: [
      ...(Array.isArray(site.requireRegex) ? site.requireRegex : []),
      ...(Array.isArray(profile.requireRegex) ? profile.requireRegex : []),
    ],
  };
}

function mergeProfileValidationIntoSite(config: Record<string, unknown>): boolean {
  if (!isJsonObject(config.captureProfile) || !isJsonObject(config.captureProfile.validation)) {
    return false;
  }

  const siteValidation = isJsonObject(config.validation) ? config.validation : {};
  const profileValidation = config.captureProfile.validation;
  const mergedValidation: Record<string, unknown> = {};

  for (const capability of ['base', 'markdown', 'screenshot', 'structured']) {
    const mergedRule = mergeValidationRule(
      siteValidation[capability],
      profileValidation[capability],
    );
    if (mergedRule !== undefined) {
      mergedValidation[capability] = mergedRule;
    }
  }

  config.validation = mergedValidation;
  delete config.captureProfile.validation;
  return true;
}

function migrateCaptureProfileConfig(configJson: string): string | null {
  const config = JSON.parse(configJson) as Record<string, unknown>;
  const hasLegacyFields =
    Object.hasOwn(config, 'captureProfiles') || Object.hasOwn(config, 'defaultCaptureProfile');

  if (hasLegacyFields && config.captureProfile === undefined) {
    const profiles = config.captureProfiles;
    const profileName =
      typeof config.defaultCaptureProfile === 'string' ? config.defaultCaptureProfile : 'default';

    if (
      profiles !== null
      && typeof profiles === 'object'
      && !Array.isArray(profiles)
      && Object.hasOwn(profiles, profileName)
    ) {
      config.captureProfile = (profiles as Record<string, unknown>)[profileName];
    }
  }

  delete config.captureProfiles;
  delete config.defaultCaptureProfile;
  const movedValidation = mergeProfileValidationIntoSite(config);
  return hasLegacyFields || movedValidation ? JSON.stringify(config) : null;
}

async function migrateStoredCaptureProfiles(db: DbClient): Promise<void> {
  const targets = [
    { table: 'sites', column: 'config_json' },
    { table: 'crawl_runs', column: 'config_snapshot_json' },
  ] as const;

  for (const target of targets) {
    const rows = await db.all<{ id: number; config_json: string }>(
      `SELECT id, ${target.column} AS config_json FROM ${target.table}`,
    );

    for (const row of rows) {
      const migratedJson = migrateCaptureProfileConfig(row.config_json);
      if (migratedJson !== null) {
        await db.run(
          `UPDATE ${target.table} SET ${target.column} = ? WHERE id = ?`,
          [migratedJson, row.id],
        );
      }
    }
  }
}

export async function initializeSchema(db: DbClient): Promise<void> {
  await db.exec(db.dialect === 'postgres' ? postgresTablesSchema : baseTablesSchema);

  const migrations = [
    `ALTER TABLE crawl_runs ADD COLUMN error_message TEXT`,
    `ALTER TABLE page_runs ADD COLUMN error_message TEXT`,
    `ALTER TABLE site_pages ADD COLUMN last_structured_status TEXT`,
    `ALTER TABLE site_pages ADD COLUMN last_structured_run_id INTEGER`,
    `ALTER TABLE site_pages ADD COLUMN last_structured_at TEXT`,
    db.dialect === 'postgres'
      ? `ALTER TABLE sites ADD COLUMN favicon_data BYTEA`
      : `ALTER TABLE sites ADD COLUMN favicon_data BLOB`,
    `ALTER TABLE sites ADD COLUMN favicon_content_type TEXT`,
    `ALTER TABLE sites ADD COLUMN favicon_updated_at TEXT`,
    `DROP INDEX IF EXISTS idx_site_pages_site_latest_handled`,
  ];

  for (const sql of migrations) {
    try {
      const migration =
        db.dialect === 'postgres' ? sql.replace('ADD COLUMN ', 'ADD COLUMN IF NOT EXISTS ') : sql;
      await db.exec(migration);
    } catch {
      // Migration already applied.
    }
  }

  await migrateStoredCaptureProfiles(db);
  await db.exec(indexesSchema);
  await db.run(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO NOTHING`,
    [
      'url_normalization',
      JSON.stringify({
        stripQueryParams: ['wbraid', 'gbraid', 'ref'],
        stripQueryParamPrefixes: ['utm_'],
      }),
      new Date().toISOString(),
    ],
  );
}
