import type { DbClient } from '../../../db/database.js';

import type { SiteConfig } from '../../../domain/types.js';

import { asCount, buildRuleReviewHints, summarizeConfig } from './read-model-utils.js';

import { RunSummaryQuery } from './run-summary-query.js';

export interface ProjectListItem {
  projectId: number;
  projectName: string;
  projectSlug: string;
  siteCount: number;
  latestActivityAt: string | null;
}

export class ProjectListQuery {
  constructor(private readonly db: DbClient) { }

  async listProjects(): Promise<ProjectListItem[]> {
    const rows = await this.db.all(
        `SELECT
           p.id,
           p.name,
           p.slug,
           COUNT(DISTINCT s.id) AS site_count,
           MAX(COALESCE(cr.finished_at, cr.started_at, s.updated_at, p.created_at)) AS latest_activity_at
         FROM projects p
         LEFT JOIN sites s ON s.project_id = p.id
         LEFT JOIN crawl_runs cr ON cr.site_id = s.id
         GROUP BY p.id, p.name, p.slug
         ORDER BY p.name`,
    );
    return rows.map((row) => ({
        projectId: Number((row as Record<string, unknown>).id),
        projectName: String((row as Record<string, unknown>).name),
        projectSlug: String((row as Record<string, unknown>).slug),
        siteCount: Number((row as Record<string, unknown>).site_count),
        latestActivityAt:
          ((row as Record<string, unknown>).latest_activity_at as string | null | undefined) ??
          null,
      }));
  }

  async listSites(projectId: number): Promise<Array<{
    siteId: number;
    siteName: string;
    baseUrl: string;
    hasFavicon: boolean;
    siteStatusLabel: string;
    totalPages: number;
    pagesNeedReview: number;
    pagesReadyForCapture: number;
    latestRunAt: string | null;
  }>> {
    const rows = await this.db.all(
        `SELECT
           s.id,
           s.name,
           s.base_url,
           s.favicon_updated_at,
           COUNT(DISTINCT sp.id) AS total_pages,
           COUNT(DISTINCT CASE WHEN sp.inventory_status = 'stage2_pending' THEN sp.id END) AS pending_pages,
           COUNT(DISTINCT CASE WHEN sp.inventory_status = 'stage2_captured' THEN sp.id END) AS captured_pages,
           MAX(COALESCE(cr.finished_at, cr.started_at)) AS latest_run_at
         FROM sites s
         LEFT JOIN site_pages sp ON sp.site_id = s.id
         LEFT JOIN crawl_runs cr ON cr.site_id = s.id
         WHERE s.project_id = ?
         GROUP BY s.id, s.name, s.base_url, s.favicon_updated_at
         ORDER BY s.name`,
      [projectId],
    );
    return rows.map((row) => {
        const pendingPages = asCount((row as Record<string, number | null>).pending_pages ?? null);
        const capturedPages = asCount(
          (row as Record<string, number | null>).captured_pages ?? null,
        );

        return {
          siteId: Number((row as Record<string, unknown>).id),
          siteName: String((row as Record<string, unknown>).name),
          baseUrl: String((row as Record<string, unknown>).base_url),
          hasFavicon: (row as Record<string, unknown>).favicon_updated_at !== null,
          siteStatusLabel:
            pendingPages > 0 ? '需要确认规则' : capturedPages > 0 ? '已开始正式采集' : '等待摸底',
          totalPages: Number((row as Record<string, unknown>).total_pages),
          pagesNeedReview: pendingPages,
          pagesReadyForCapture: capturedPages,
          latestRunAt:
            ((row as Record<string, unknown>).latest_run_at as string | null | undefined) ?? null,
        };
      });
  }
}

export class SiteOverviewQuery {
  constructor(private readonly db: DbClient) { }

  async getSiteOverview(siteId: number): Promise<{
    siteId: number;
    siteName: string;
    projectId: number;
    projectName: string;
    baseUrl: string;
    siteStatusLabel: string;
    configSummary: ReturnType<typeof summarizeConfig>;
    pagesReadyForCapture: number;
    pagesNeedReview: number;
    pagesExcluded: number;
    pagesCaptured: number;
    totalPages: number;
    latestSuccessfulCaptureAt: string | null;
    latestSeedRun: Awaited<ReturnType<RunSummaryQuery['getLatestRunForSite']>>;
    latestCrawlRun: Awaited<ReturnType<RunSummaryQuery['getLatestRunForSite']>>;
    ruleReviewHints: string[];
    workflowSteps: Array<{
      key: string;
      title: string;
      status: 'todo' | 'active' | 'done';
      description: string;
    }>;
  }> {
    const row = await this.db.get<{
        id: number;
        name: string;
        base_url: string;
        config_json: string;
        project_id: number;
        project_name: string;
        total_pages: number;
        pending_pages: number | null;
        denied_pages: number | null;
        captured_pages: number | null;
        latest_successful_capture_at: string | null;
      }>(
        `SELECT
           s.id,
           s.name,
           s.base_url,
           s.config_json,
           p.id AS project_id,
           p.name AS project_name,
           COUNT(sp.id) AS total_pages,
           SUM(CASE WHEN sp.inventory_status = 'stage2_pending' THEN 1 ELSE 0 END) AS pending_pages,
           SUM(CASE WHEN sp.inventory_status = 'url_rule_denied' THEN 1 ELSE 0 END) AS denied_pages,
           SUM(CASE WHEN sp.inventory_status = 'stage2_captured' THEN 1 ELSE 0 END) AS captured_pages,
           MAX(CASE WHEN sp.inventory_status = 'stage2_captured' THEN COALESCE(sp.last_markdown_at, sp.last_screenshot_at, sp.last_structured_at, sp.last_base_at) END) AS latest_successful_capture_at
         FROM sites s
         INNER JOIN projects p ON p.id = s.project_id
         LEFT JOIN site_pages sp ON sp.site_id = s.id
         WHERE s.id = ?
         GROUP BY s.id, s.name, s.base_url, s.config_json, p.id, p.name`,
      [siteId],
    );

    if (!row) {
      throw new Error(`Site ${siteId} not found`);
    }

    const pendingPages = asCount(row.pending_pages);
    const deniedPages = asCount(row.denied_pages);
    const capturedPages = asCount(row.captured_pages);
    const config = JSON.parse(row.config_json) as SiteConfig;
    const runSummaryQuery = new RunSummaryQuery(this.db);
    const latestSeedRun = await runSummaryQuery.getLatestRunForSite(siteId, 'seed_run');
    const latestCrawlRun = await runSummaryQuery.getLatestRunForSite(siteId, 'crawl_run');

    return {
      siteId: row.id,
      siteName: row.name,
      projectId: row.project_id,
      projectName: row.project_name,
      baseUrl: row.base_url,
      siteStatusLabel:
        capturedPages > 0
          ? '已进入正式采集'
          : pendingPages > 0
            ? '需要确认规则'
            : latestSeedRun
              ? '已完成初步摸底'
              : '等待准备',
      configSummary: summarizeConfig(config),
      pagesReadyForCapture: Math.max(row.total_pages - deniedPages, 0),
      pagesNeedReview: pendingPages,
      pagesExcluded: deniedPages,
      pagesCaptured: capturedPages,
      totalPages: row.total_pages,
      latestSuccessfulCaptureAt: row.latest_successful_capture_at,
      latestSeedRun,
      latestCrawlRun,
      ruleReviewHints: buildRuleReviewHints({
        pendingPages,
        deniedPages,
        capturedPages,
      }),
      workflowSteps: [
        {
          key: 'prepare',
          title: '准备站点',
          status: 'done',
          description: '确认基础网址、起始页面和站点地图是否完整。',
        },
        {
          key: 'seed',
          title: '初步摸底',
          status: latestSeedRun ? 'done' : 'active',
          description: '先收集基础页面信息，了解站点范围。',
        },
        {
          key: 'review',
          title: '确认采集规则',
          status: pendingPages > 0 ? 'active' : latestSeedRun ? 'done' : 'todo',
          description: '处理待确认页面，收紧或放宽采集规则。',
        },
        {
          key: 'crawl',
          title: '正式采集',
          status: capturedPages > 0 ? 'done' : latestSeedRun ? 'active' : 'todo',
          description: '启动正式采集并跟踪整体覆盖率。',
        },
      ],
    };
  }
}
