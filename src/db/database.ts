import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(databasePath: string): DatabaseSync {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

export function initializeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      tag_definitions_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      storage_root TEXT NOT NULL,
      config_json TEXT NOT NULL,
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
      first_discovered_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(site_id, normalized_url),
      FOREIGN KEY (site_id) REFERENCES sites(id),
      FOREIGN KEY (last_base_run_id) REFERENCES crawl_runs(id),
      FOREIGN KEY (last_markdown_run_id) REFERENCES crawl_runs(id),
      FOREIGN KEY (last_screenshot_run_id) REFERENCES crawl_runs(id)
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
      classification_tags_json TEXT NOT NULL,
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

    CREATE INDEX IF NOT EXISTS idx_site_pages_site_inventory
      ON site_pages(site_id, inventory_status);

    CREATE INDEX IF NOT EXISTS idx_page_runs_run
      ON page_runs(crawl_run_id);

    CREATE INDEX IF NOT EXISTS idx_artifact_runs_run
      ON artifact_runs(crawl_run_id);

    CREATE INDEX IF NOT EXISTS idx_run_logs_run
      ON run_logs(crawl_run_id);
  `);

  // ── Schema migrations (idempotent ALTER TABLE) ──────────────────────────────
  // SQLite does not support IF NOT EXISTS on ALTER TABLE, so we wrap each in a
  // try/catch so re-running on an existing database is safe.
  const migrations = [
    `ALTER TABLE crawl_runs ADD COLUMN error_message TEXT`,
    `ALTER TABLE page_runs  ADD COLUMN error_message TEXT`,
  ];

  for (const sql of migrations) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists – ignore.
    }
  }
}
