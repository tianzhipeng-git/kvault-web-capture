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
    CREATE TABLE IF NOT EXISTS sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      root_url TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS crawl_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL,
      seed_url TEXT NOT NULL,
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
      latest_title TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(site_id, normalized_url),
      FOREIGN KEY (site_id) REFERENCES sites(id)
    );

    CREATE TABLE IF NOT EXISTS page_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      crawl_run_id INTEGER NOT NULL,
      site_page_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      meta_description TEXT NOT NULL,
      body_text TEXT NOT NULL,
      classifier_tags_json TEXT NOT NULL,
      decision_outcome TEXT NOT NULL,
      required_artifacts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (crawl_run_id) REFERENCES crawl_runs(id),
      FOREIGN KEY (site_page_id) REFERENCES site_pages(id)
    );

    CREATE TABLE IF NOT EXISTS artifact_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      crawl_run_id INTEGER NOT NULL,
      site_page_id INTEGER NOT NULL,
      artifact_type TEXT NOT NULL,
      status TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (crawl_run_id) REFERENCES crawl_runs(id),
      FOREIGN KEY (site_page_id) REFERENCES site_pages(id)
    );
  `);
}
