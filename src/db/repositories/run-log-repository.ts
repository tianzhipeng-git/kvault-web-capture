import type { DatabaseSync } from 'node:sqlite';
import type { Clock } from '../../utils/clock.js';
import { parseJson } from './helpers.js';

export type RunLogLevel = 'info' | 'warn' | 'error';

export type RunLogEvent =
  | 'crawl_started'
  | 'crawl_finished'
  | 'crawl_error'
  | 'runtime_log_ready'
  | 'base_page_done'
  | 'base_page_failed'
  | 'base_page_skipped_target_reached'
  | 'target_success_count_reached'
  | 'artifact_done'
  | 'artifact_failed';

export interface RunLogRecord {
  id: number;
  crawlRunId: number;
  level: RunLogLevel;
  event: RunLogEvent;
  url: string | null;
  sitePageId: number | null;
  pageRunId: number | null;
  message: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export class RunLogRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  log(input: {
    crawlRunId: number;
    level: RunLogLevel;
    event: RunLogEvent;
    url?: string | null;
    sitePageId?: number | null;
    pageRunId?: number | null;
    message: string;
    meta?: Record<string, unknown> | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO run_logs (
          crawl_run_id, level, event, url, site_page_id, page_run_id,
          message, meta_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.crawlRunId,
        input.level,
        input.event,
        input.url ?? null,
        input.sitePageId ?? null,
        input.pageRunId ?? null,
        input.message,
        input.meta !== undefined && input.meta !== null ? JSON.stringify(input.meta) : null,
        this.clock.now(),
      );
  }

  listByRun(runId: number): RunLogRecord[] {
    return (this.db
      .prepare(
        `SELECT id, crawl_run_id, level, event, url, site_page_id, page_run_id,
                message, meta_json, created_at
         FROM run_logs
         WHERE crawl_run_id = ?
         ORDER BY id`,
      )
      .all(runId) as Array<Record<string, unknown>>).map((row) => ({
      id: Number(row.id),
      crawlRunId: Number(row.crawl_run_id),
      level: row.level as RunLogLevel,
      event: row.event as RunLogEvent,
      url: (row.url as string | null) ?? null,
      sitePageId: row.site_page_id !== null ? Number(row.site_page_id) : null,
      pageRunId: row.page_run_id !== null ? Number(row.page_run_id) : null,
      message: String(row.message),
      meta:
        row.meta_json !== null
          ? parseJson<Record<string, unknown>>(row.meta_json as string)
          : null,
      createdAt: String(row.created_at),
    }));
  }
}
