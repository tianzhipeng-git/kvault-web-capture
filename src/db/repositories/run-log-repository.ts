import type { DbClient } from '../database.js';
import type { Clock } from '../../utils/clock.js';
import { parseJson } from './helpers.js';

export type RunLogLevel = 'info' | 'warn' | 'error';

export type RunLogEvent =
  | 'crawl_started'
  | 'crawl_finished'
  | 'crawl_error'
  | 'runtime_log_ready'
  | 'feishu_notification_failed'
  | 'sitemap_skipped'
  | 'url_plan_skipped'
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
    private readonly db: DbClient,
    private readonly clock: Clock,
  ) {}

  // Aggressive sugar: keep event names as method names.
  runtime_log_ready(crawlRunId: number, relativePath: string): Promise<void> {
    return this.info(
      crawlRunId,
      'runtime_log_ready',
      `Runtime log available at ${relativePath}`,
      { meta: { relativePath } },
    );
  }

  crawl_started(
    crawlRunId: number,
    input: {
      runType: unknown;
      updatePolicy: unknown;
      targetSuccessCount: number | null;
      siteId: number;
    },
  ): Promise<void> {
    return this.info(
      crawlRunId,
      'crawl_started',
      `Run ${crawlRunId} started (${String(input.runType)}, updatePolicy=${String(input.updatePolicy)})`,
      {
        meta: {
          runType: input.runType,
          updatePolicy: input.updatePolicy,
          targetSuccessCount: input.targetSuccessCount,
          siteId: input.siteId,
        },
      },
    );
  }

  crawl_finished(crawlRunId: number): Promise<void> {
    return this.info(crawlRunId, 'crawl_finished', `Run ${crawlRunId} finished successfully`);
  }

  crawl_error(
    crawlRunId: number,
    errorMessage: string,
    meta?: { stack?: string | null } | null,
  ): Promise<void> {
    return this.error(
      crawlRunId,
      'crawl_error',
      `Run ${crawlRunId} failed: ${errorMessage}`,
      { meta: meta ?? undefined },
    );
  }

  feishu_notification_failed(crawlRunId: number, errorMessage: string): Promise<void> {
    return this.warn(
      crawlRunId,
      'feishu_notification_failed',
      `Feishu notification failed for run ${crawlRunId}: ${errorMessage}`,
    );
  }

  sitemap_skipped(
    crawlRunId: number,
    sitemapUrl: string,
    error: { name: string; message: string; stack?: string | null },
    meta?: Record<string, unknown> | null,
  ): Promise<void> {
    return this.warn(
      crawlRunId,
      'sitemap_skipped',
      `[startup] SKIPPED sitemap ${sitemapUrl}: ${error.message}`,
      {
        url: sitemapUrl,
        meta: {
          reason: 'sitemap_fetch_failed',
          errorName: error.name,
          errorMessage: error.message,
          stack: error.stack ?? null,
          ...(meta ?? {}),
        },
      },
    );
  }

  url_plan_skipped(
    crawlRunId: number,
    url: string,
    meta?: Record<string, unknown> | null,
    options?: { sitePageId?: number | null; pageRunId?: number | null } | null,
  ): Promise<void> {
    return this.warn(
      crawlRunId,
      'url_plan_skipped',
      `[plan] SKIPPED invalid URL ${url}`,
      {
        url,
        sitePageId: options?.sitePageId,
        pageRunId: options?.pageRunId,
        meta: meta ?? undefined,
      },
    );
  }

  base_page_done(input: {
    crawlRunId: number;
    url: string;
    sitePageId: number;
    pageRunId: number;
    outcome: string;
    meta?: Record<string, unknown> | null;
  }): Promise<void> {
    return this.info(
      input.crawlRunId,
      'base_page_done',
      `[base] ${String(input.outcome).toUpperCase()} ${input.url}`,
      {
        url: input.url,
        sitePageId: input.sitePageId,
        pageRunId: input.pageRunId,
        meta: input.meta ?? undefined,
      },
    );
  }

  target_success_count_reached(input: {
    crawlRunId: number;
    url: string;
    sitePageId: number;
    pageRunId: number;
    targetSuccessCount: number;
    candidateSuccessCount: number;
  }): Promise<void> {
    return this.info(
      input.crawlRunId,
      'target_success_count_reached',
      `Run ${input.crawlRunId} reached targetSuccessCount=${input.targetSuccessCount}`,
      {
        url: input.url,
        sitePageId: input.sitePageId,
        pageRunId: input.pageRunId,
        meta: {
          targetSuccessCount: input.targetSuccessCount,
          candidateSuccessCount: input.candidateSuccessCount,
        },
      },
    );
  }

  async info(
    crawlRunId: number,
    event: RunLogEvent,
    message: string,
    options?: {
      url?: string | null;
      sitePageId?: number | null;
      pageRunId?: number | null;
      meta?: Record<string, unknown> | null;
    },
  ): Promise<void> {
    return this.log({
      crawlRunId,
      level: 'info',
      event,
      message,
      url: options?.url,
      sitePageId: options?.sitePageId,
      pageRunId: options?.pageRunId,
      meta: options?.meta,
    });
  }

  async warn(
    crawlRunId: number,
    event: RunLogEvent,
    message: string,
    options?: {
      url?: string | null;
      sitePageId?: number | null;
      pageRunId?: number | null;
      meta?: Record<string, unknown> | null;
    },
  ): Promise<void> {
    return this.log({
      crawlRunId,
      level: 'warn',
      event,
      message,
      url: options?.url,
      sitePageId: options?.sitePageId,
      pageRunId: options?.pageRunId,
      meta: options?.meta,
    });
  }

  async error(
    crawlRunId: number,
    event: RunLogEvent,
    message: string,
    options?: {
      url?: string | null;
      sitePageId?: number | null;
      pageRunId?: number | null;
      meta?: Record<string, unknown> | null;
    },
  ): Promise<void> {
    return this.log({
      crawlRunId,
      level: 'error',
      event,
      message,
      url: options?.url,
      sitePageId: options?.sitePageId,
      pageRunId: options?.pageRunId,
      meta: options?.meta,
    });
  }

  async log(input: {
    crawlRunId: number;
    level: RunLogLevel;
    event: RunLogEvent;
    url?: string | null;
    sitePageId?: number | null;
    pageRunId?: number | null;
    message: string;
    meta?: Record<string, unknown> | null;
  }): Promise<void> {
    await this.db.run(
        `INSERT INTO run_logs (
          crawl_run_id, level, event, url, site_page_id, page_run_id,
          message, meta_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.crawlRunId,
        input.level,
        input.event,
        input.url ?? null,
        input.sitePageId ?? null,
        input.pageRunId ?? null,
        input.message,
        input.meta !== undefined && input.meta !== null ? JSON.stringify(input.meta) : null,
        this.clock.now(),
      ],
    );
  }

  async listByRun(runId: number): Promise<RunLogRecord[]> {
    const rows = await this.db.all<Record<string, unknown>>(
        `SELECT id, crawl_run_id, level, event, url, site_page_id, page_run_id,
                message, meta_json, created_at
         FROM run_logs
         WHERE crawl_run_id = ?
         ORDER BY id`,
      [runId],
    );
    return rows.map((row) => ({
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
