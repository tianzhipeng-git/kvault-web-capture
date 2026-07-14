import { readFile } from 'node:fs/promises';



import type { DbClient, DbValue } from '../../../db/database.js';

import type { RunType, SiteConfig, UpdatePolicy } from '../../../domain/types.js';

import { loadRunProgress, type RunProgress } from '../run-progress.js';

import { readTextFile, summarizeConfig, toRunStatusLabel, toRunTypeLabel } from './read-model-utils.js';

export class RunSummaryQuery {
  constructor(private readonly db: DbClient) { }

  private mapRunListRow(row: Record<string, unknown>, progress: RunProgress): {
    runId: number;
    runType: RunType;
    runTypeLabel: string;
    updatePolicy: UpdatePolicy;
    status: string;
    statusLabel: string;
    startedAt: string;
    finishedAt: string | null;
    successfulPages: number;
    failedPages: number;
    pendingPages: number;
    deniedPages: number;
    successfulArtifacts: number;
    failedArtifacts: number;
    targetSuccessCount: number | null;
    configSummary: ReturnType<typeof summarizeConfig>;
  } {
    const config = JSON.parse(String(row.config_snapshot_json)) as SiteConfig;

    return {
      runId: Number(row.id),
      runType: row.run_type as RunType,
      runTypeLabel: toRunTypeLabel(String(row.run_type)),
      updatePolicy: row.update_policy as UpdatePolicy,
      status: String(row.status),
      statusLabel: toRunStatusLabel(String(row.status)),
      startedAt: String(row.started_at),
      finishedAt: (row.finished_at as string | null | undefined) ?? null,
      successfulPages: progress.successfulPages,
      failedPages: progress.failedPages,
      pendingPages: progress.pendingPages,
      deniedPages: progress.deniedPages,
      successfulArtifacts: progress.successfulArtifacts,
      failedArtifacts: progress.failedArtifacts,
      targetSuccessCount:
        (row.target_success_count as number | null | undefined) ?? null,
      configSummary: summarizeConfig(config),
    };
  }

  async getRunPageIds(runId: number): Promise<{
    runId: number;
    siteId: number;
    pageIds: number[];
  }> {
    const run = await this.db.get<{ site_id: number }>(
      'SELECT site_id FROM crawl_runs WHERE id = ?',
      [runId],
    );

    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }

    const rows = await this.db.all<{ site_page_id: number }>(
        `SELECT site_page_id
         FROM (
           SELECT DISTINCT site_page_id
           FROM page_runs
           WHERE crawl_run_id = ?
           UNION
           SELECT DISTINCT site_page_id
           FROM artifact_runs
           WHERE crawl_run_id = ?
         ) run_pages
         ORDER BY site_page_id`,
      [runId, runId],
    );

    return {
      runId,
      siteId: run.site_id,
      pageIds: rows.map((row) => Number(row.site_page_id)),
    };
  }

  async getRunMarkdown(runId: number): Promise<{
    runId: number;
    siteId: number;
    markdown: string;
    pageCount: number;
  }> {
    const run = await this.db.get<{ site_id: number }>(
      'SELECT site_id FROM crawl_runs WHERE id = ?',
      [runId],
    );

    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }

    const rows = await this.db.all<{
        site_page_id: number;
        normalized_url: string;
        title: string | null;
        output_path: string | null;
        content: string | null;
      }>(
        `SELECT
           ar.site_page_id,
           sp.normalized_url,
           COALESCE(sp.latest_title, pr.title) AS title,
           ar.output_path,
           ar.content
         FROM artifact_runs ar
         INNER JOIN site_pages sp ON sp.id = ar.site_page_id
         LEFT JOIN page_runs pr ON pr.id = ar.page_run_id
         WHERE ar.crawl_run_id = ?
           AND ar.artifact_type = 'markdown'
           AND ar.status = 'succeeded'
         ORDER BY ar.site_page_id, ar.id`,
      [runId],
    );

    const parts: string[] = [];
    for (const row of rows) {
      const content = row.content ?? await readTextFile(row.output_path);

      if (!content?.trim()) {
        continue;
      }

      parts.push([
        `# ${row.title ?? row.normalized_url}`,
        '',
        row.normalized_url,
        '',
        content.trim(),
      ].join('\n'));
    }

    if (parts.length === 0) {
      throw new Error('本次运行没有成功 Markdown 产物。');
    }

    return {
      runId,
      siteId: run.site_id,
      markdown: parts.join('\n\n---\n\n'),
      pageCount: parts.length,
    };
  }

  async listSiteRuns(input: {
    siteId: number;
    page: number;
    pageSize: number;
    runType?: RunType;
  }): Promise<{
    total: number;
    page: number;
    pageSize: number;
    items: Array<{
    runId: number;
    runType: RunType;
    runTypeLabel: string;
    updatePolicy: UpdatePolicy;
    status: string;
    statusLabel: string;
    startedAt: string;
    finishedAt: string | null;
    successfulPages: number;
    failedPages: number;
    pendingPages: number;
    deniedPages: number;
    successfulArtifacts: number;
    failedArtifacts: number;
    targetSuccessCount: number | null;
    configSummary: ReturnType<typeof summarizeConfig>;
    }>;
  }> {
    const filters = ['site_id = ?'];
    const args: DbValue[] = [input.siteId];

    if (input.runType) {
      filters.push('run_type = ?');
      args.push(input.runType);
    }

    const whereClause = filters.join(' AND ');
    const totalRow = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM crawl_runs WHERE ${whereClause}`,
      args,
    );
    const offset = (input.page - 1) * input.pageSize;
    const rows = await this.db.all<Record<string, unknown>>(
        `SELECT
           id,
           run_type,
           update_policy,
           status,
           started_at,
           finished_at,
           successful_page_count,
           pending_page_count,
           denied_page_count,
           target_success_count,
           config_snapshot_json
         FROM crawl_runs
         WHERE ${whereClause}
         ORDER BY id DESC
         LIMIT ? OFFSET ?`,
      [...args, input.pageSize, offset],
    );

    const progressByRun = await loadRunProgress(
      this.db,
      rows.map((row) => Number(row.id)),
    );

    return {
      total: Number(totalRow?.count ?? 0),
      page: input.page,
      pageSize: input.pageSize,
      items: rows.map((row) => this.mapRunListRow(
        row,
        progressByRun.get(Number(row.id))!,
      )),
    };
  }

  async getLatestRunForSite(siteId: number, runType: 'seed_run' | 'crawl_run'): Promise<{
    runId: number;
    runTypeLabel: string;
    statusLabel: string;
    startedAt: string;
    finishedAt: string | null;
    successfulPages: number;
    failedPages: number;
    pendingPages: number;
    deniedPages: number;
    successfulArtifacts: number;
    failedArtifacts: number;
  } | null> {
    const result = await this.listSiteRuns({
      siteId,
      runType,
      page: 1,
      pageSize: 1,
    });
    return result.items[0] ?? null;
  }

  async getRunSummary(runId: number): Promise<{
    runId: number;
    siteId: number;
    runTypeLabel: string;
    statusLabel: string;
    startedAt: string;
    finishedAt: string | null;
    successfulPages: number;
    failedPages: number;
    pendingPages: number;
    deniedPages: number;
    successfulArtifacts: number;
    failedArtifacts: number;
    targetSuccessCount: number | null;
    configSummary: ReturnType<typeof summarizeConfig>;
    issues: string[];
  }> {
    const row = await this.db.get<{
        id: number;
        site_id: number;
        run_type: string;
        status: string;
        started_at: string;
        finished_at: string | null;
        successful_page_count: number;
        pending_page_count: number;
        denied_page_count: number;
        target_success_count: number | null;
        config_snapshot_json: string;
      }>(
        `SELECT
           id,
           site_id,
           run_type,
           status,
           started_at,
           finished_at,
           successful_page_count,
           pending_page_count,
           denied_page_count,
           target_success_count,
           config_snapshot_json
         FROM crawl_runs
         WHERE id = ?`,
      [runId],
    );

    if (!row) {
      throw new Error(`Run ${runId} not found`);
    }

    const progress = (await loadRunProgress(this.db, [runId])).get(runId)!;
    const issues: string[] = [];

    if (progress.pendingPages > 0) {
      issues.push(`本次运行后还有 ${progress.pendingPages} 个页面需要人工确认。`);
    }

    if (progress.deniedPages > 0) {
      issues.push(`有 ${progress.deniedPages} 个页面被排除在本次采集范围之外。`);
    }

    if (row.status === 'failed') {
      issues.push('运行没有完整结束，请检查站点配置或抓取日志。');
    }

    if (row.status === 'cancelled') {
      issues.push('运行已被手动取消。');
    }

    return {
      runId: row.id,
      siteId: row.site_id,
      runTypeLabel: toRunTypeLabel(row.run_type),
      statusLabel: toRunStatusLabel(row.status),
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      successfulPages: progress.successfulPages,
      failedPages: progress.failedPages,
      pendingPages: progress.pendingPages,
      deniedPages: progress.deniedPages,
      successfulArtifacts: progress.successfulArtifacts,
      failedArtifacts: progress.failedArtifacts,
      targetSuccessCount: row.target_success_count,
      configSummary: summarizeConfig(JSON.parse(row.config_snapshot_json) as SiteConfig),
      issues,
    };
  }
}
