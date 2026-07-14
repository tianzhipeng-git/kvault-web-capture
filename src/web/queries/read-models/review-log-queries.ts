import { readFile } from 'node:fs/promises';

import { resolve, sep } from 'node:path';



import type { DbClient, DbValue } from '../../../db/database.js';

import { parseJson, toPendingReasonLabel } from './read-model-utils.js';

export class PendingReviewQuery {
  constructor(private readonly db: DbClient) { }

  async getPendingReview(siteId: number): Promise<Array<{
    reason: string;
    reasonLabel: string;
    count: number;
    nextAction: string;
    pages: Array<{
      sitePageId: number;
      title: string;
      url: string;
      preview: string;
      matchedRules: string[];
    }>;
  }>> {
    const groups = await this.db.all(
        `SELECT
           sp.last_pending_reason,
           COUNT(*) AS count
         FROM site_pages sp
         WHERE sp.site_id = ? AND sp.inventory_status = 'stage2_pending'
         GROUP BY sp.last_pending_reason
         ORDER BY count DESC`,
      [siteId],
    );

    return Promise.all(groups.map(async (group) => {
      const record = group as Record<string, unknown>;
      const reason = String(record.last_pending_reason ?? 'unknown');
      const pages = (await this.db.all(
          `SELECT
             sp.id,
             sp.normalized_url,
             COALESCE(sp.latest_title, sp.normalized_url) AS title,
             pr.body_text
           FROM site_pages sp
           LEFT JOIN page_runs pr ON pr.id = (
             SELECT pr2.id
             FROM page_runs pr2
             WHERE pr2.site_page_id = sp.id
             ORDER BY pr2.id DESC
             LIMIT 1
           )
           WHERE sp.site_id = ? AND sp.inventory_status = 'stage2_pending' AND sp.last_pending_reason = ?
           ORDER BY sp.id DESC
           LIMIT 5`,
        [siteId, reason],
      )).map((page) => {
          const pageRecord = page as Record<string, unknown>;
          const previewSource = String(pageRecord.body_text ?? '');

          return {
            sitePageId: Number(pageRecord.id),
            title: String(pageRecord.title),
            url: String(pageRecord.normalized_url),
            preview: previewSource.slice(0, 140),
            matchedRules: [],
          };
        });

      return {
        reason,
        reasonLabel: toPendingReasonLabel(reason) ?? '待确认',
        count: Number(record.count),
        nextAction:
          reason === 'seed_run'
            ? '先检查初步摸底结果，再启动正式采集。'
            : '调整分类或采集规则后，再重新发起一次运行。',
        pages,
      };
    }));
  }
}

export interface RunLogItem {
  logId: number;
  crawlRunId: number;
  sitePageId: number | null;
  pageRunId: number | null;
  level: string;
  event: string;
  url: string | null;
  message: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export class RunLogQuery {
  constructor(private readonly db: DbClient) { }

  async listRunLogs(runId: number, sitePageId?: number): Promise<RunLogItem[]> {
    const filters = ['crawl_run_id = ?'];
    const params: DbValue[] = [runId];

    if (sitePageId !== undefined) {
      filters.push('site_page_id = ?');
      params.push(sitePageId);
    }

    const rows = await this.db.all<{
        id: number;
        crawl_run_id: number;
        site_page_id: number | null;
        page_run_id: number | null;
        level: string;
        event: string;
        url: string | null;
        message: string;
        meta_json: string | null;
        created_at: string;
      }>(
        `SELECT id, crawl_run_id, site_page_id, page_run_id, level, event, url, message, meta_json, created_at
         FROM run_logs
         WHERE ${filters.join(' AND ')}
         ORDER BY id ASC`,
      params,
    );

    return rows.map((row) => ({
      logId: row.id,
      crawlRunId: row.crawl_run_id,
      sitePageId: row.site_page_id,
      pageRunId: row.page_run_id,
      level: row.level,
      event: row.event,
      url: row.url,
      message: row.message,
      meta: row.meta_json ? (JSON.parse(row.meta_json) as Record<string, unknown>) : null,
      createdAt: row.created_at,
    }));
  }

  async getRunErrorMessage(runId: number): Promise<string | null> {
    const row = await this.db.get<{ error_message: string | null }>(
      `SELECT error_message FROM crawl_runs WHERE id = ?`,
      [runId],
    );
    return row?.error_message ?? null;
  }

  async getRuntimeLog(runId: number, tailLines = 500): Promise<{
    relativePath: string;
    content: string;
    truncated: boolean;
  } | null> {
    const row = await this.db.get<{ storage_root: string; meta_json: string | null }>(
        `SELECT s.storage_root, rl.meta_json
         FROM run_logs rl
         INNER JOIN crawl_runs cr ON cr.id = rl.crawl_run_id
         INNER JOIN sites s ON s.id = cr.site_id
         WHERE rl.crawl_run_id = ? AND rl.event = 'runtime_log_ready'
         ORDER BY rl.id DESC
         LIMIT 1`,
      [runId],
    );

    if (!row?.meta_json) {
      return null;
    }

    const meta = parseJson<{ relativePath?: unknown }>(row.meta_json);
    const relativePath = typeof meta?.relativePath === 'string' ? meta.relativePath : null;

    if (!relativePath) {
      return null;
    }

    const storageRoot = resolve(row.storage_root);
    const absolutePath = resolve(storageRoot, relativePath);

    if (absolutePath !== storageRoot && !absolutePath.startsWith(`${storageRoot}${sep}`)) {
      return null;
    }

    let content: string;

    try {
      content = await readFile(absolutePath, 'utf8');
    } catch {
      return {
        relativePath,
        content: '',
        truncated: false,
      };
    }
    const lines = content.split(/\r?\n/);

    if (tailLines <= 0 || lines.length <= tailLines) {
      return {
        relativePath,
        content,
        truncated: false,
      };
    }

    return {
      relativePath,
      content: lines.slice(-tailLines).join('\n'),
      truncated: true,
    };
  }
}
