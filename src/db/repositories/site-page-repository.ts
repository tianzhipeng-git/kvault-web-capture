import type { DbClient } from '../database.js';
import type { ArtifactRunStatus, ArtifactType, BaseCaptureStatus, HistoricalPageState, InventoryStatus, RuleOutcome, StageDecisionSnapshot } from '../../domain/types.js';
import type { Clock } from '../../utils/clock.js';
import { deriveInventoryStatus, parseJson } from './helpers.js';

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
    private readonly db: DbClient,
    private readonly clock: Clock,
  ) {}

  async upsertDiscovery(input: {
    siteId: number;
    discoveredUrl: string;
    normalizedUrl: string;
    discoverySource: string;
    discoveryReferrerUrl: string | null;
    inventoryStatus?: InventoryStatus;
    urlRuleDecision?: 'allow' | 'deny' | null;
  }): Promise<number> {
    const now = this.clock.now();

    if (this.db.dialect === 'postgres') {
      const result = await this.db.run(
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (site_id, normalized_url) DO UPDATE
        SET updated_at = EXCLUDED.updated_at,
            discovered_url = EXCLUDED.discovered_url,
            discovery_source = EXCLUDED.discovery_source,
            discovery_referrer_url = COALESCE(EXCLUDED.discovery_referrer_url, site_pages.discovery_referrer_url),
            inventory_status = COALESCE(?, site_pages.inventory_status),
            last_url_rule_decision = COALESCE(?, site_pages.last_url_rule_decision)
        RETURNING id`,
        [
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
          input.inventoryStatus ?? null,
          input.urlRuleDecision ?? null,
        ],
      );

      return Number(result.lastInsertId);
    }

    const existing = await this.db.get<{ id: number }>(
      'SELECT id FROM site_pages WHERE site_id = ? AND normalized_url = ?',
      [input.siteId, input.normalizedUrl],
    );

    if (existing) {
      await this.db.run(
        `UPDATE site_pages
         SET updated_at = ?,
             discovered_url = ?,
             discovery_source = ?,
             discovery_referrer_url = COALESCE(?, discovery_referrer_url),
             inventory_status = COALESCE(?, inventory_status),
             last_url_rule_decision = COALESCE(?, last_url_rule_decision)
         WHERE id = ?`,
        [
          now,
          input.discoveredUrl,
          input.discoverySource,
          input.discoveryReferrerUrl,
          input.inventoryStatus ?? null,
          input.urlRuleDecision ?? null,
          existing.id,
        ],
      );
      return existing.id;
    }

    const result = await this.db.run(
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
      [
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
      ],
    );

    return Number(result.lastInsertId);
  }

  async getHistoricalState(siteId: number, normalizedUrl: string): Promise<HistoricalPageState | null> {
    const row = await this.db.get<{
      id: number;
      normalized_url: string;
      inventory_status: InventoryStatus;
      last_base_status: BaseCaptureStatus | null;
      last_base_at: string | null;
      latest_classification_labels_json: string | null;
      last_stage_decision_json: string | null;
      last_markdown_status: ArtifactRunStatus | null;
      last_markdown_at: string | null;
      last_screenshot_status: ArtifactRunStatus | null;
      last_screenshot_at: string | null;
    }>(
      `SELECT
         id,
         normalized_url,
         inventory_status,
         last_base_status,
         last_base_at,
         (
           SELECT classification_labels_json
           FROM page_runs
           WHERE page_runs.site_page_id = site_pages.id
           ORDER BY page_runs.id DESC
           LIMIT 1
         ) AS latest_classification_labels_json,
         last_stage_decision_json,
         last_markdown_status,
         last_markdown_at,
         last_screenshot_status,
         last_screenshot_at
       FROM site_pages
       WHERE site_id = ? AND normalized_url = ?`,
      [siteId, normalizedUrl],
    );

    if (!row) {
      return null;
    }

    return {
      sitePageId: row.id,
      normalizedUrl: row.normalized_url,
      inventoryStatus: row.inventory_status,
      lastBaseStatus: row.last_base_status,
      lastBaseAt: row.last_base_at,
      latestClassificationLabels:
        row.latest_classification_labels_json === null
          ? null
          : parseJson<Record<string, string[]>>(row.latest_classification_labels_json),
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

  async markUrlRuleDenied(sitePageId: number): Promise<void> {
    await this.db.run(
      `UPDATE site_pages
       SET inventory_status = 'url_rule_denied',
           last_url_rule_decision = 'deny',
           updated_at = ?
       WHERE id = ?`,
      [this.clock.now(), sitePageId],
    );
  }

  async recordBaseCapture(input: {
    sitePageId: number;
    runId: number;
    title: string;
    pageOutcome: RuleOutcome;
    requiredArtifacts: ArtifactType[];
    pendingReason: string | null;
  }): Promise<void> {
    const now = this.clock.now();
    const inventoryStatus = deriveInventoryStatus({
      pageOutcome: input.pageOutcome,
      requiredArtifacts: input.requiredArtifacts,
      artifactStatuses: {},
    });

    await this.db.run(
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
      [
        input.title,
        inventoryStatus,
        JSON.stringify({
          outcome: input.pageOutcome,
          requiredArtifacts: input.requiredArtifacts,
        } satisfies StageDecisionSnapshot),
        input.pendingReason,
        input.runId,
        now,
        now,
        input.sitePageId,
      ],
    );
  }

  async recordBaseCaptureFailed(input: {
    sitePageId: number;
    runId: number;
  }): Promise<void> {
    const now = this.clock.now();
    await this.db.run(
      `UPDATE site_pages
       SET last_base_status = 'failed',
           last_base_run_id = ?,
           last_base_at = ?,
           updated_at = ?
       WHERE id = ?`,
      [input.runId, now, now, input.sitePageId],
    );
  }

  async recordArtifactResult(input: {
    sitePageId: number;
    runId: number;
    artifactType: ArtifactType;
    status: ArtifactRunStatus;
  }): Promise<void> {
    const row = await this.db.get<{
      last_stage_decision_json: string | null;
      last_markdown_status: ArtifactRunStatus | null;
      last_screenshot_status: ArtifactRunStatus | null;
    }>(
      `SELECT
         last_stage_decision_json,
         last_markdown_status,
         last_screenshot_status
       FROM site_pages
       WHERE id = ?`,
      [input.sitePageId],
    );

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
      await this.db.run(
        `UPDATE site_pages
         SET inventory_status = ?,
             last_markdown_status = ?,
             last_markdown_run_id = ?,
             last_markdown_at = ?,
             updated_at = ?
         WHERE id = ?`,
        [inventoryStatus, input.status, input.runId, now, now, input.sitePageId],
      );
      return;
    }

    await this.db.run(
      `UPDATE site_pages
       SET inventory_status = ?,
           last_screenshot_status = ?,
           last_screenshot_run_id = ?,
           last_screenshot_at = ?,
           updated_at = ?
       WHERE id = ?`,
      [inventoryStatus, input.status, input.runId, now, now, input.sitePageId],
    );
  }

  async summarizeInventory(siteId: number): Promise<InventorySummary> {
    const row = await this.db.get<{
      total_pages: number;
      pending_pages: number | null;
      denied_pages: number | null;
      captured_pages: number | null;
    }>(
      `SELECT
         COUNT(*) AS total_pages,
         SUM(CASE WHEN inventory_status = 'stage2_pending' THEN 1 ELSE 0 END) AS pending_pages,
         SUM(CASE WHEN inventory_status = 'url_rule_denied' THEN 1 ELSE 0 END) AS denied_pages,
         SUM(CASE WHEN inventory_status = 'stage2_captured' THEN 1 ELSE 0 END) AS captured_pages
       FROM site_pages
       WHERE site_id = ?`,
      [siteId],
    );

    return {
      totalPages: Number(row?.total_pages ?? 0),
      pendingPages: Number(row?.pending_pages ?? 0),
      deniedPages: Number(row?.denied_pages ?? 0),
      capturedPages: Number(row?.captured_pages ?? 0),
    };
  }

  async listByInventoryStatus(siteId: number, status: InventoryStatus): Promise<InventoryPageRow[]> {
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT id, normalized_url, inventory_status, last_pending_reason, latest_title
       FROM site_pages
       WHERE site_id = ? AND inventory_status = ?
       ORDER BY normalized_url`,
      [siteId, status],
    );
    return rows.map((row) => ({
      sitePageId: Number(row.id),
      normalizedUrl: String(row.normalized_url),
      inventoryStatus: String(row.inventory_status),
      pendingReason: (row.last_pending_reason as string | null | undefined) ?? null,
      latestTitle: (row.latest_title as string | null | undefined) ?? null,
    }));
  }

  async listKnownUrls(siteId: number): Promise<KnownSitePageRow[]> {
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT discovered_url, normalized_url
       FROM site_pages
       WHERE site_id = ?
       ORDER BY id`,
      [siteId],
    );
    return rows.map((row) => ({
      discoveredUrl: String(row.discovered_url),
      normalizedUrl: String(row.normalized_url),
    }));
  }
}
