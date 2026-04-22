import type { DatabaseSync } from 'node:sqlite';

import type {
  ArtifactRunStatus,
  ArtifactType,
  BaseCaptureStatus,
  CrawlRunCreateInput,
  HistoricalPageState,
  InventoryStatus,
  RuleOutcome,
  RunStatus,
  SiteConfig,
  UpdatePolicy,
} from '../domain/types.js';
import type { Clock } from '../utils/clock.js';

interface RowIdResult {
  lastInsertRowid: number | bigint;
}

function toId(result: RowIdResult): number {
  return Number(result.lastInsertRowid);
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface ProjectRecord {
  id: number;
  name: string;
  slug: string;
}

export interface SiteRecord {
  id: number;
  projectId: number;
  name: string;
  baseUrl: string;
  storageRoot: string;
  config: SiteConfig;
}

export interface CrawlRunRecord {
  id: number;
  siteId: number;
  runType: 'inventory_preview' | 'crawl_run';
  updatePolicy: UpdatePolicy;
  status: RunStatus;
  configSnapshot: SiteConfig;
}

export interface InventorySummary {
  totalPages: number;
  pendingPages: number;
  deniedPages: number;
  capturedPages: number;
}

export interface InventoryPageRow {
  sitePageId: number;
  normalizedUrl: string;
  inventoryStatus: string;
  pendingReason: string | null;
  latestTitle: string | null;
}

export interface SampleCaptureRow {
  normalizedUrl: string;
  title: string;
  metaDescription: string;
  bodyText: string;
}

export interface KnownSitePageRow {
  discoveredUrl: string;
  normalizedUrl: string;
}

export class ProjectRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  create(name: string): ProjectRecord {
    const slug = slugify(name);
    const existing = this.db
      .prepare('SELECT id, name, slug FROM projects WHERE slug = ?')
      .get(slug) as ProjectRecord | undefined;

    if (existing) {
      return existing;
    }

    const result = this.db
      .prepare(
        'INSERT INTO projects (name, slug, tag_definitions_json, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(name, slug, '[]', this.clock.now()) as RowIdResult;

    return {
      id: toId(result),
      name,
      slug,
    };
  }

  getBySlug(slug: string): ProjectRecord | null {
    return (
      (this.db
        .prepare('SELECT id, name, slug FROM projects WHERE slug = ?')
        .get(slug) as ProjectRecord | undefined) ?? null
    );
  }
}

export class SiteRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  create(input: {
    projectId: number;
    name: string;
    baseUrl: string;
    storageRoot: string;
    config: SiteConfig;
  }): SiteRecord {
    const now = this.clock.now();
    const result = this.db
      .prepare(
        `INSERT INTO sites (
          project_id,
          name,
          base_url,
          storage_root,
          config_json,
          updated_at,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        input.name,
        input.baseUrl,
        input.storageRoot,
        JSON.stringify(input.config),
        now,
        now,
      ) as RowIdResult;

    return {
      id: toId(result),
      projectId: input.projectId,
      name: input.name,
      baseUrl: input.baseUrl,
      storageRoot: input.storageRoot,
      config: input.config,
    };
  }

  getById(siteId: number): SiteRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, name, base_url, storage_root, config_json
         FROM sites
         WHERE id = ?`,
      )
      .get(siteId) as
      | {
          id: number;
          project_id: number;
          name: string;
          base_url: string;
          storage_root: string;
          config_json: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      baseUrl: row.base_url,
      storageRoot: row.storage_root,
      config: parseJson<SiteConfig>(row.config_json),
    };
  }

  updateConfig(siteId: number, config: SiteConfig): void {
    this.db
      .prepare('UPDATE sites SET config_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(config), this.clock.now(), siteId);
  }

  cloneConfig(sourceSiteId: number, targetSiteId: number): void {
    const source = this.getById(sourceSiteId);

    if (!source) {
      throw new Error(`Site ${sourceSiteId} not found`);
    }

    this.updateConfig(targetSiteId, source.config);
  }
}

export class RunRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  createRun(input: CrawlRunCreateInput): number {
    const now = this.clock.now();
    const result = this.db
      .prepare(
        `INSERT INTO crawl_runs (
          site_id,
          run_type,
          update_policy,
          target_success_count,
          config_snapshot_json,
          status,
          started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.siteId,
        input.runType,
        input.updatePolicy,
        input.targetSuccessCount,
        JSON.stringify(input.configSnapshot),
        'running',
        now,
      ) as RowIdResult;

    return toId(result);
  }

  getById(runId: number): CrawlRunRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, site_id, run_type, update_policy, status, config_snapshot_json
         FROM crawl_runs
         WHERE id = ?`,
      )
      .get(runId) as
      | {
          id: number;
          site_id: number;
          run_type: 'inventory_preview' | 'crawl_run';
          update_policy: UpdatePolicy;
          status: RunStatus;
          config_snapshot_json: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      siteId: row.site_id,
      runType: row.run_type,
      updatePolicy: row.update_policy,
      status: row.status,
      configSnapshot: parseJson<SiteConfig>(row.config_snapshot_json),
    };
  }

  finishRun(runId: number, status: RunStatus): void {
    this.db
      .prepare('UPDATE crawl_runs SET status = ?, finished_at = ? WHERE id = ?')
      .run(status, this.clock.now(), runId);
  }

  refreshCounts(runId: number): void {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN decision_outcome = 'deny' THEN 1 ELSE 0 END) AS denied_count,
           SUM(CASE WHEN decision_outcome = 'pending' THEN 1 ELSE 0 END) AS pending_count
         FROM page_runs
         WHERE crawl_run_id = ?`,
      )
      .get(runId) as {
      denied_count: number | null;
      pending_count: number | null;
    };

    const candidateRow = this.db
      .prepare('SELECT COUNT(*) AS count FROM page_runs WHERE crawl_run_id = ?')
      .get(runId) as { count: number };

    const successfulRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM page_runs
         WHERE crawl_run_id = ?
           AND decision_outcome = 'allow'
           AND required_artifacts_json = '["markdown"]'
           AND EXISTS (
             SELECT 1
             FROM artifact_runs
             WHERE artifact_runs.page_run_id = page_runs.id
               AND artifact_runs.artifact_type = 'markdown'
               AND artifact_runs.status = 'succeeded'
           )`,
      )
      .get(runId) as { count: number };

    this.db
      .prepare(
        `UPDATE crawl_runs
         SET candidate_page_count = ?,
             pending_page_count = ?,
             denied_page_count = ?,
             successful_page_count = ?
         WHERE id = ?`,
      )
      .run(
        candidateRow.count,
        row.pending_count ?? 0,
        row.denied_count ?? 0,
        successfulRow.count,
        runId,
      );
  }
}

export class SitePageRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  upsertDiscovery(input: {
    siteId: number;
    discoveredUrl: string;
    normalizedUrl: string;
    discoverySource: string;
    discoveryReferrerUrl: string | null;
    inventoryStatus?: InventoryStatus;
    urlRuleDecision?: 'allow' | 'deny' | null;
  }): number {
    const existing = this.db
      .prepare('SELECT id FROM site_pages WHERE site_id = ? AND normalized_url = ?')
      .get(input.siteId, input.normalizedUrl) as { id: number } | undefined;

    const now = this.clock.now();

    if (existing) {
      this.db
        .prepare(
          `UPDATE site_pages
           SET updated_at = ?,
               discovered_url = ?,
               discovery_source = ?,
               discovery_referrer_url = COALESCE(?, discovery_referrer_url),
               inventory_status = COALESCE(?, inventory_status),
               last_url_rule_decision = COALESCE(?, last_url_rule_decision)
           WHERE id = ?`,
        )
        .run(
          now,
          input.discoveredUrl,
          input.discoverySource,
          input.discoveryReferrerUrl,
          input.inventoryStatus ?? null,
          input.urlRuleDecision ?? null,
          existing.id,
        );

      return existing.id;
    }

    const result = this.db
      .prepare(
        `INSERT INTO site_pages (
          site_id,
          discovered_url,
          normalized_url,
          inventory_status,
          discovery_source,
          discovery_referrer_url,
          last_url_rule_decision,
          first_discovered_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.siteId,
        input.discoveredUrl,
        input.normalizedUrl,
        input.inventoryStatus ?? 'discovered_only',
        input.discoverySource,
        input.discoveryReferrerUrl,
        input.urlRuleDecision ?? null,
        now,
        now,
        now,
      ) as RowIdResult;

    return toId(result);
  }

  getHistoricalState(siteId: number, normalizedUrl: string): HistoricalPageState | null {
    const row = this.db
      .prepare(
        `SELECT
           id,
           normalized_url,
           inventory_status,
           last_base_status,
           last_base_at,
           last_tag_rule_decision,
           last_markdown_status,
           last_markdown_at
         FROM site_pages
         WHERE site_id = ? AND normalized_url = ?`,
      )
      .get(siteId, normalizedUrl) as
      | {
          id: number;
          normalized_url: string;
          inventory_status: InventoryStatus;
          last_base_status: BaseCaptureStatus | null;
          last_base_at: string | null;
          last_tag_rule_decision: RuleOutcome | null;
          last_markdown_status: ArtifactRunStatus | null;
          last_markdown_at: string | null;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      sitePageId: row.id,
      normalizedUrl: row.normalized_url,
      inventoryStatus: row.inventory_status,
      lastBaseStatus: row.last_base_status,
      lastBaseAt: row.last_base_at,
      lastTagRuleDecision: row.last_tag_rule_decision,
      lastMarkdownStatus: row.last_markdown_status,
      lastMarkdownAt: row.last_markdown_at,
    };
  }

  markUrlRuleDenied(sitePageId: number): void {
    this.db
      .prepare(
        `UPDATE site_pages
         SET inventory_status = 'url_rule_denied',
             last_url_rule_decision = 'deny',
             updated_at = ?
         WHERE id = ?`,
      )
      .run(this.clock.now(), sitePageId);
  }

  recordBaseCapture(input: {
    sitePageId: number;
    runId: number;
    title: string;
    tagOutcome: RuleOutcome;
    pageOutcome: RuleOutcome;
    pendingReason: string | null;
  }): void {
    const inventoryStatus =
      input.pageOutcome === 'deny'
        ? 'stage2_skipped'
        : input.pageOutcome === 'allow'
          ? 'base_captured'
          : 'stage2_pending';

    this.db
      .prepare(
        `UPDATE site_pages
         SET latest_title = ?,
             inventory_status = ?,
             last_tag_rule_decision = ?,
             last_pending_reason = ?,
             last_base_status = 'succeeded',
             last_base_run_id = ?,
             last_base_at = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.title,
        inventoryStatus,
        input.tagOutcome,
        input.pendingReason,
        input.runId,
        this.clock.now(),
        this.clock.now(),
        input.sitePageId,
      );
  }

  recordMarkdownResult(input: {
    sitePageId: number;
    runId: number;
    status: ArtifactRunStatus;
  }): void {
    const inventoryStatus = input.status === 'succeeded' ? 'stage2_captured' : 'stage2_pending';

    this.db
      .prepare(
        `UPDATE site_pages
         SET inventory_status = ?,
             last_markdown_status = ?,
             last_markdown_run_id = ?,
             last_markdown_at = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        inventoryStatus,
        input.status,
        input.runId,
        this.clock.now(),
        this.clock.now(),
        input.sitePageId,
      );
  }

  summarizeInventory(siteId: number): InventorySummary {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total_pages,
           SUM(CASE WHEN inventory_status = 'stage2_pending' THEN 1 ELSE 0 END) AS pending_pages,
           SUM(CASE WHEN inventory_status = 'url_rule_denied' THEN 1 ELSE 0 END) AS denied_pages,
           SUM(CASE WHEN inventory_status = 'stage2_captured' THEN 1 ELSE 0 END) AS captured_pages
         FROM site_pages
         WHERE site_id = ?`,
      )
      .get(siteId) as {
      total_pages: number;
      pending_pages: number | null;
      denied_pages: number | null;
      captured_pages: number | null;
    };

    return {
      totalPages: row.total_pages,
      pendingPages: row.pending_pages ?? 0,
      deniedPages: row.denied_pages ?? 0,
      capturedPages: row.captured_pages ?? 0,
    };
  }

  listByInventoryStatus(siteId: number, status: InventoryStatus): InventoryPageRow[] {
    return this.db
      .prepare(
        `SELECT id, normalized_url, inventory_status, last_pending_reason, latest_title
         FROM site_pages
         WHERE site_id = ? AND inventory_status = ?
         ORDER BY normalized_url`,
      )
      .all(siteId, status)
      .map((row) => ({
        sitePageId: Number((row as Record<string, unknown>).id),
        normalizedUrl: String((row as Record<string, unknown>).normalized_url),
        inventoryStatus: String((row as Record<string, unknown>).inventory_status),
        pendingReason:
          ((row as Record<string, unknown>).last_pending_reason as string | null | undefined) ??
          null,
        latestTitle:
          ((row as Record<string, unknown>).latest_title as string | null | undefined) ?? null,
      }));
  }

  listKnownUrls(siteId: number): KnownSitePageRow[] {
    return this.db
      .prepare(
        `SELECT discovered_url, normalized_url
         FROM site_pages
         WHERE site_id = ?
         ORDER BY id`,
      )
      .all(siteId)
      .map((row) => ({
        discoveredUrl: String((row as Record<string, unknown>).discovered_url),
        normalizedUrl: String((row as Record<string, unknown>).normalized_url),
      }));
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
    baseCaptureStatus: BaseCaptureStatus;
    title: string;
    metaDescription: string;
    bodyText: string;
    classificationTags: Record<string, string[]>;
    tagRuleOutcome: RuleOutcome;
    decisionOutcome: RuleOutcome;
    decisionReason: string | null;
    pendingReason: string | null;
    requiredArtifacts: ArtifactType[];
  }): number {
    const now = this.clock.now();
    const result = this.db
      .prepare(
        `INSERT INTO page_runs (
          crawl_run_id,
          site_page_id,
          started_at,
          finished_at,
          base_capture_status,
          title,
          meta_description,
          body_text,
          classification_tags_json,
          tag_rule_outcome,
          decision_outcome,
          decision_reason,
          pending_reason,
          required_artifacts_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.sitePageId,
        now,
        now,
        input.baseCaptureStatus,
        input.title,
        input.metaDescription,
        input.bodyText,
        JSON.stringify(input.classificationTags),
        input.tagRuleOutcome,
        input.decisionOutcome,
        input.decisionReason,
        input.pendingReason,
        JSON.stringify(input.requiredArtifacts),
      ) as RowIdResult;

    return toId(result);
  }

  countByRun(runId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM page_runs WHERE crawl_run_id = ?')
      .get(runId) as { count: number };
    return row.count;
  }

  listSampleCaptures(siteId: number, limit: number): SampleCaptureRow[] {
    return this.db
      .prepare(
        `SELECT sp.normalized_url, pr.title, pr.meta_description, pr.body_text
         FROM page_runs pr
         INNER JOIN site_pages sp ON sp.id = pr.site_page_id
         WHERE sp.site_id = ?
         ORDER BY pr.id DESC
         LIMIT ?`,
      )
      .all(siteId, limit)
      .map((row) => ({
        normalizedUrl: String((row as Record<string, unknown>).normalized_url),
        title: String((row as Record<string, unknown>).title),
        metaDescription: String((row as Record<string, unknown>).meta_description),
        bodyText: String((row as Record<string, unknown>).body_text),
      }));
  }
}

export class ArtifactRunRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  create(input: {
    runId: number;
    pageRunId: number;
    sitePageId: number;
    artifactType: ArtifactType;
    status: ArtifactRunStatus;
    content: string | null;
    outputPath: string | null;
    errorMessage: string | null;
  }): number {
    const now = this.clock.now();
    const result = this.db
      .prepare(
        `INSERT INTO artifact_runs (
          crawl_run_id,
          page_run_id,
          site_page_id,
          artifact_type,
          status,
          started_at,
          finished_at,
          output_path,
          content,
          error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.pageRunId,
        input.sitePageId,
        input.artifactType,
        input.status,
        now,
        now,
        input.outputPath,
        input.content,
        input.errorMessage,
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
