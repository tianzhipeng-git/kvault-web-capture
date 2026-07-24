import type { DbClient, DbValue } from '../../../db/database.js';

import { parseJson, toInventoryStatusLabel, toPendingReasonLabel } from './read-model-utils.js';
import { parseArtifactRequirementsJson } from '../../../domain/artifact-requirements.js';

export interface SitePageListInput {
  siteId: number;
  page: number;
  pageSize: number;
  status?: string | string[];
  query?: string;
  label?: string;
  pendingReason?: string;
  discoverySource?: string;
  crawlRunId?: number;
}

export class SitePageListQuery {
  constructor(private readonly db: DbClient) { }

  async listPages(input: SitePageListInput): Promise<{
    total: number;
    page: number;
    pageSize: number;
    rows: Array<{
      sitePageId: number;
      title: string;
      url: string;
      businessStatus: string;
      labels: string[];
      latestOutcome: string;
      latestHandledAt: string | null;
      needsReview: boolean;
      pendingReasonLabel: string | null;
      discoverySource: string;
      captureSummary: string;
    }>;
  }> {
    const filters: string[] = ['sp.site_id = ?'];
    const args: DbValue[] = [input.siteId];

    const statuses = Array.isArray(input.status)
      ? input.status.filter(Boolean)
      : input.status
        ? [input.status]
        : [];

    if (statuses.length > 0) {
      filters.push(`sp.inventory_status IN (${statuses.map(() => '?').join(', ')})`);
      args.push(...statuses);
    }

    if (input.query) {
      filters.push('(sp.normalized_url LIKE ? OR COALESCE(sp.latest_title, \'\') LIKE ?)');
      args.push(`%${input.query}%`, `%${input.query}%`);
    }

    if (input.pendingReason) {
      filters.push('sp.last_pending_reason = ?');
      args.push(input.pendingReason);
    }

    if (input.discoverySource) {
      filters.push('sp.discovery_source = ?');
      args.push(input.discoverySource);
    }

    if (input.crawlRunId !== undefined) {
      filters.push(
        `(EXISTS (
           SELECT 1
           FROM page_runs pr_run_filter
           WHERE pr_run_filter.site_page_id = sp.id
             AND pr_run_filter.crawl_run_id = ?
         ) OR EXISTS (
           SELECT 1
           FROM artifact_runs ar_run_filter
           WHERE ar_run_filter.site_page_id = sp.id
             AND ar_run_filter.crawl_run_id = ?
         ))`,
      );
      args.push(input.crawlRunId, input.crawlRunId);
    }

    if (input.label) {
      filters.push(
        `EXISTS (
           SELECT 1
           FROM page_runs prt
           WHERE prt.site_page_id = sp.id
             AND prt.id = (
               SELECT pr2.id
               FROM page_runs pr2
               WHERE pr2.site_page_id = sp.id
               ORDER BY pr2.id DESC
               LIMIT 1
             )
             AND prt.classification_labels_json LIKE ?
         )`,
      );
      args.push(`%${input.label}%`);
    }

    const whereClause = filters.join(' AND ');
    const totalRow = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM site_pages sp WHERE ${whereClause}`,
      args,
    );

    const offset = (input.page - 1) * input.pageSize;
    const rows = await this.db.all(
        `SELECT
           sp.id,
           sp.normalized_url,
           sp.inventory_status,
           sp.last_pending_reason,
           sp.latest_title,
           sp.discovery_source,
           COALESCE(sp.last_markdown_at, sp.last_screenshot_at, sp.last_structured_at, sp.last_base_at) AS latest_handled_at,
           pr.classification_labels_json,
           pr.decision_outcome,
           pr.required_artifacts_json,
           sp.last_markdown_status,
           sp.last_screenshot_status,
           sp.last_structured_status
         FROM site_pages sp
         LEFT JOIN page_runs pr ON pr.id = (
           SELECT pr2.id
           FROM page_runs pr2
           WHERE pr2.site_page_id = sp.id
           ORDER BY pr2.id DESC
           LIMIT 1
         )
         WHERE ${whereClause}
         ORDER BY latest_handled_at DESC, sp.id DESC
         LIMIT ? OFFSET ?`,
      [...args, input.pageSize, offset],
    );

    return {
      total: Number(totalRow?.count ?? 0),
      page: input.page,
      pageSize: input.pageSize,
      rows: rows.map((row) => {
        const record = row as Record<string, unknown>;
        const labels = parseJson<Record<string, string[]>>(
          (record.classification_labels_json as string | null | undefined) ?? null,
        );
        const requiredArtifacts = parseArtifactRequirementsJson(
          (record.required_artifacts_json as string | null | undefined) ?? null,
        ).map((requirement) => requirement.artifactType);
        const markdownDone = record.last_markdown_status === 'succeeded';
        const screenshotDone = record.last_screenshot_status === 'succeeded';
        const structuredDone = record.last_structured_status === 'succeeded';
        const captureSummaryParts = requiredArtifacts.map((artifactType) => {
          if (artifactType === 'markdown') {
            return markdownDone ? 'Markdown 已生成' : 'Markdown 待定';
          }
          if (artifactType === 'screenshot') {
            return screenshotDone ? '截图已生成' : '截图待定';
          }
          if (artifactType === 'structured') {
            return structuredDone ? '结构化已生成' : '结构化待定';
          }
          return `${artifactType} 待定`;
        });

        return {
          sitePageId: Number(record.id),
          title: String(record.latest_title ?? record.normalized_url),
          url: String(record.normalized_url),
          businessStatus: toInventoryStatusLabel(String(record.inventory_status)),
          labels: Object.entries(labels ?? {}).flatMap(([key, values]) =>
            values.map((value) => `${key}: ${value}`),
          ),
          latestOutcome:
            record.decision_outcome === 'deny'
              ? '不采集'
              : record.decision_outcome === 'pending'
                ? '待确认'
                : '继续采集',
          latestHandledAt: (record.latest_handled_at as string | null | undefined) ?? null,
          needsReview: record.inventory_status === 'stage2_pending',
          pendingReasonLabel: toPendingReasonLabel(
            (record.last_pending_reason as string | null | undefined) ?? null,
          ),
          discoverySource: String(record.discovery_source),
          captureSummary:
            requiredArtifacts.length === 0
              ? '只保留基础信息'
              : captureSummaryParts.join(' / '),
        };
      }),
    };
  }
}

type ProcessingKind = 'base' | 'markdown' | 'screenshot' | 'structured';
