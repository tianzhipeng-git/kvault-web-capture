import type { DatabaseSync } from 'node:sqlite';

import type {
  ArtifactRunStatus,
  ArtifactType,
  PageRunStatus,
  RuleDecision,
  RunStatus,
} from '../domain/types.js';
import type { Clock } from '../utils/clock.js';

interface RowIdResult {
  lastInsertRowid: number | bigint;
}

function toId(result: RowIdResult): number {
  return Number(result.lastInsertRowid);
}

export class SiteRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  ensureSite(name: string, rootUrl: string): number {
    const existing = this.db
      .prepare('SELECT id FROM sites WHERE root_url = ?')
      .get(rootUrl) as { id: number } | undefined;

    if (existing) {
      return existing.id;
    }

    const now = this.clock.now();
    const result = this.db
      .prepare('INSERT INTO sites (name, root_url, created_at) VALUES (?, ?, ?)')
      .run(name, rootUrl, now) as RowIdResult;

    return toId(result);
  }
}

export class RunRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  createRun(siteId: number, seedUrl: string): number {
    const now = this.clock.now();
    const result = this.db
      .prepare(
        'INSERT INTO crawl_runs (site_id, seed_url, status, started_at) VALUES (?, ?, ?, ?)',
      )
      .run(siteId, seedUrl, 'running', now) as RowIdResult;

    return toId(result);
  }

  finishRun(runId: number, status: RunStatus): void {
    this.db
      .prepare('UPDATE crawl_runs SET status = ?, finished_at = ? WHERE id = ?')
      .run(status, this.clock.now(), runId);
  }
}

export class SitePageRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  createOrGet(siteId: number, discoveredUrl: string, normalizedUrl: string): number {
    const existing = this.db
      .prepare('SELECT id FROM site_pages WHERE site_id = ? AND normalized_url = ?')
      .get(siteId, normalizedUrl) as { id: number } | undefined;

    if (existing) {
      return existing.id;
    }

    const now = this.clock.now();
    const result = this.db
      .prepare(
        `INSERT INTO site_pages (
          site_id,
          discovered_url,
          normalized_url,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(siteId, discoveredUrl, normalizedUrl, now, now) as RowIdResult;

    return toId(result);
  }

  updateLatestTitle(sitePageId: number, title: string): void {
    this.db
      .prepare('UPDATE site_pages SET latest_title = ?, updated_at = ? WHERE id = ?')
      .run(title, this.clock.now(), sitePageId);
  }
}

export class PageRunRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  create(input: {
    runId: number;
    sitePageId: number;
    status: PageRunStatus;
    title: string;
    metaDescription: string;
    bodyText: string;
    classifierTags: string[];
    ruleDecision: RuleDecision;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO page_runs (
          crawl_run_id,
          site_page_id,
          status,
          title,
          meta_description,
          body_text,
          classifier_tags_json,
          decision_outcome,
          required_artifacts_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.sitePageId,
        input.status,
        input.title,
        input.metaDescription,
        input.bodyText,
        JSON.stringify(input.classifierTags),
        input.ruleDecision.outcome,
        JSON.stringify(input.ruleDecision.requiredArtifacts),
        this.clock.now(),
      ) as RowIdResult;

    return toId(result);
  }

  countByRun(runId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM page_runs WHERE crawl_run_id = ?')
      .get(runId) as { count: number };
    return row.count;
  }
}

export class ArtifactRunRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  create(input: {
    runId: number;
    sitePageId: number;
    artifactType: ArtifactType;
    status: ArtifactRunStatus;
    content: string;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO artifact_runs (
          crawl_run_id,
          site_page_id,
          artifact_type,
          status,
          content,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.sitePageId,
        input.artifactType,
        input.status,
        input.content,
        this.clock.now(),
      ) as RowIdResult;

    return toId(result);
  }

  countByRun(runId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM artifact_runs WHERE crawl_run_id = ?')
      .get(runId) as { count: number };
    return row.count;
  }
}
