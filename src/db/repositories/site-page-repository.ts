import type { DatabaseSync } from 'node:sqlite';
import type { ArtifactRunStatus, ArtifactType, BaseCaptureStatus, HistoricalPageState, InventoryStatus, RuleOutcome, StageDecisionSnapshot } from '../../domain/types.js';
import type { Clock } from '../../utils/clock.js';
import { type RowIdResult, deriveInventoryStatus, parseJson, toId } from './helpers.js';

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
  baseCapturePath: string | null;
  title: string;
  metaDescription: string;
  bodyText: string;
}

export interface KnownSitePageRow {
  discoveredUrl: string;
  normalizedUrl: string;
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
           (
             SELECT classification_tags_json
             FROM page_runs
             WHERE page_runs.site_page_id = site_pages.id
             ORDER BY page_runs.id DESC
             LIMIT 1
           ) AS latest_classification_tags_json,
           last_stage_decision_json,
           last_markdown_status,
           last_markdown_at,
           last_screenshot_status,
           last_screenshot_at
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
          latest_classification_tags_json: string | null;
          last_stage_decision_json: string | null;
          last_markdown_status: ArtifactRunStatus | null;
          last_markdown_at: string | null;
          last_screenshot_status: ArtifactRunStatus | null;
          last_screenshot_at: string | null;
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
      latestClassificationTags:
        row.latest_classification_tags_json === null
          ? null
          : parseJson<Record<string, string[]>>(row.latest_classification_tags_json),
      lastStageDecision:
        row.last_stage_decision_json === null
          ? null
          : parseJson<StageDecisionSnapshot>(row.last_stage_decision_json),
      lastMarkdownStatus: row.last_markdown_status,
      lastMarkdownAt: row.last_markdown_at,
      lastScreenshotStatus: row.last_screenshot_status,
      lastScreenshotAt: row.last_screenshot_at,
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
    pageOutcome: RuleOutcome;
    requiredArtifacts: ArtifactType[];
    pendingReason: string | null;
  }): void {
    const inventoryStatus = deriveInventoryStatus({
      pageOutcome: input.pageOutcome,
      requiredArtifacts: input.requiredArtifacts,
      artifactStatuses: {},
    });

    this.db
      .prepare(
        `UPDATE site_pages
         SET latest_title = ?,
             inventory_status = ?,
             last_stage_decision_json = ?,
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
        JSON.stringify({
          outcome: input.pageOutcome,
          requiredArtifacts: input.requiredArtifacts,
        } satisfies StageDecisionSnapshot),
        input.pendingReason,
        input.runId,
        this.clock.now(),
        this.clock.now(),
        input.sitePageId,
      );
  }

  recordBaseCaptureFailed(input: {
    sitePageId: number;
    runId: number;
  }): void {
    this.db
      .prepare(
        `UPDATE site_pages
         SET last_base_status = 'failed',
             last_base_run_id = ?,
             last_base_at = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(input.runId, this.clock.now(), this.clock.now(), input.sitePageId);
  }

  recordArtifactResult(input: {
    sitePageId: number;
    runId: number;
    artifactType: ArtifactType;
    status: ArtifactRunStatus;
  }): void {
    const row = this.db
      .prepare(
        `SELECT
           last_stage_decision_json,
           last_markdown_status,
           last_screenshot_status
         FROM site_pages
         WHERE id = ?`,
      )
      .get(input.sitePageId) as
      | {
          last_stage_decision_json: string | null;
          last_markdown_status: ArtifactRunStatus | null;
          last_screenshot_status: ArtifactRunStatus | null;
        }
      | undefined;

    if (!row || row.last_stage_decision_json === null) {
      throw new Error(`Missing stage decision for site page ${input.sitePageId}`);
    }

    const stageDecision = parseJson<StageDecisionSnapshot>(row.last_stage_decision_json);
    const artifactStatuses: Partial<Record<ArtifactType, ArtifactRunStatus | null>> = {
      markdown: row.last_markdown_status,
      screenshot: row.last_screenshot_status,
      [input.artifactType]: input.status,
    };
    const inventoryStatus = deriveInventoryStatus({
      pageOutcome: stageDecision.outcome,
      requiredArtifacts: stageDecision.requiredArtifacts,
      artifactStatuses,
    });
    const now = this.clock.now();

    if (input.artifactType === 'markdown') {
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
        .run(inventoryStatus, input.status, input.runId, now, now, input.sitePageId);
      return;
    }

    this.db
      .prepare(
        `UPDATE site_pages
         SET inventory_status = ?,
             last_screenshot_status = ?,
             last_screenshot_run_id = ?,
             last_screenshot_at = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(inventoryStatus, input.status, input.runId, now, now, input.sitePageId);
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

