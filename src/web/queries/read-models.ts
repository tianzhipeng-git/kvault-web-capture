import { existsSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import type { SiteConfig } from '../../domain/types.js';

function parseJson<T>(value: string | null): T | null {
  if (value === null) {
    return null;
  }

  return JSON.parse(value) as T;
}

function readTextFile(path: string | null): string | null {
  if (path === null || !existsSync(path)) {
    return null;
  }

  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function asCount(value: number | null): number {
  return value ?? 0;
}

function summarizeConfig(config: SiteConfig): {
  seedUrlCount: number;
  sitemapCount: number;
  preFilterRuleCount: number;
  captureRuleCount: number;
  seedDepth: number;
  crawlDepth: number;
} {
  return {
    seedUrlCount: config.seedUrls.length,
    sitemapCount: config.sitemaps.length,
    preFilterRuleCount: config.rulesBeforeBaseEq.length,
    captureRuleCount: config.rulesBeforeStage2Eq.length,
    seedDepth: config.runOptions.seedMaxDepth,
    crawlDepth: config.runOptions.crawlMaxDepth,
  };
}

export function toRunTypeLabel(runType: string): string {
  return runType === 'seed_run' ? '初步摸底' : '正式采集';
}

export function toInventoryStatusLabel(status: string): string {
  switch (status) {
    case 'url_rule_denied':
      return '不采集';
    case 'stage2_captured':
      return '已完成采集';
    case 'stage2_pending':
      return '待确认';
    case 'stage2_skipped':
      return '无需深入采集';
    case 'base_captured':
      return '已完成基础信息';
    default:
      return '未知';
  }
}

export function toPendingReasonLabel(reason: string | null): string | null {
  switch (reason) {
    case 'classifier_failed':
      return '页面分类未完成';
    case 'rule_unmatched':
      return '采集规则还不够明确';
    case 'seed_run':
      return '初步摸底只采集了基础信息';
    default:
      return null;
  }
}

function toRunStatusLabel(status: string): string {
  switch (status) {
    case 'running':
      return '进行中';
    case 'failed':
      return '失败';
    default:
      return '已完成';
  }
}

function buildRuleReviewHints(input: {
  pendingPages: number;
  deniedPages: number;
  capturedPages: number;
}): string[] {
  const hints: string[] = [];

  if (input.pendingPages > 0) {
    hints.push(`还有 ${input.pendingPages} 个页面需要确认规则后再继续采集。`);
  }

  if (input.deniedPages > 0) {
    hints.push(`当前有 ${input.deniedPages} 个页面被排除在采集范围之外。`);
  }

  if (input.capturedPages === 0) {
    hints.push('还没有页面完成正式采集，可以先检查配置范围和分类规则。');
  }

  return hints;
}

export interface ProjectListItem {
  projectId: number;
  projectName: string;
  projectSlug: string;
  siteCount: number;
  latestActivityAt: string | null;
}

export class ProjectListQuery {
  constructor(private readonly db: DatabaseSync) { }

  listProjects(): ProjectListItem[] {
    return this.db
      .prepare(
        `SELECT
           p.id,
           p.name,
           p.slug,
           COUNT(DISTINCT s.id) AS site_count,
           MAX(COALESCE(cr.finished_at, cr.started_at, s.updated_at, p.created_at)) AS latest_activity_at
         FROM projects p
         LEFT JOIN sites s ON s.project_id = p.id
         LEFT JOIN crawl_runs cr ON cr.site_id = s.id
         GROUP BY p.id
         ORDER BY p.name`,
      )
      .all()
      .map((row) => ({
        projectId: Number((row as Record<string, unknown>).id),
        projectName: String((row as Record<string, unknown>).name),
        projectSlug: String((row as Record<string, unknown>).slug),
        siteCount: Number((row as Record<string, unknown>).site_count),
        latestActivityAt:
          ((row as Record<string, unknown>).latest_activity_at as string | null | undefined) ??
          null,
      }));
  }

  listSites(projectId: number): Array<{
    siteId: number;
    siteName: string;
    baseUrl: string;
    siteStatusLabel: string;
    totalPages: number;
    pagesNeedReview: number;
    pagesReadyForCapture: number;
    latestRunAt: string | null;
  }> {
    return this.db
      .prepare(
        `SELECT
           s.id,
           s.name,
           s.base_url,
           COUNT(DISTINCT sp.id) AS total_pages,
           COUNT(DISTINCT CASE WHEN sp.inventory_status = 'stage2_pending' THEN sp.id END) AS pending_pages,
           COUNT(DISTINCT CASE WHEN sp.inventory_status = 'stage2_captured' THEN sp.id END) AS captured_pages,
           MAX(COALESCE(cr.finished_at, cr.started_at)) AS latest_run_at
         FROM sites s
         LEFT JOIN site_pages sp ON sp.site_id = s.id
         LEFT JOIN crawl_runs cr ON cr.site_id = s.id
         WHERE s.project_id = ?
         GROUP BY s.id
         ORDER BY s.name`,
      )
      .all(projectId)
      .map((row) => {
        const pendingPages = asCount((row as Record<string, number | null>).pending_pages ?? null);
        const capturedPages = asCount(
          (row as Record<string, number | null>).captured_pages ?? null,
        );

        return {
          siteId: Number((row as Record<string, unknown>).id),
          siteName: String((row as Record<string, unknown>).name),
          baseUrl: String((row as Record<string, unknown>).base_url),
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
  constructor(private readonly db: DatabaseSync) { }

  getSiteOverview(siteId: number): {
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
    latestSeedRun: ReturnType<RunSummaryQuery['getLatestRunForSite']>;
    latestCrawlRun: ReturnType<RunSummaryQuery['getLatestRunForSite']>;
    ruleReviewHints: string[];
    workflowSteps: Array<{
      key: string;
      title: string;
      status: 'todo' | 'active' | 'done';
      description: string;
    }>;
  } {
    const row = this.db
      .prepare(
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
           MAX(CASE WHEN sp.inventory_status = 'stage2_captured' THEN COALESCE(sp.last_markdown_at, sp.last_screenshot_at, sp.last_base_at) END) AS latest_successful_capture_at
         FROM sites s
         INNER JOIN projects p ON p.id = s.project_id
         LEFT JOIN site_pages sp ON sp.site_id = s.id
         WHERE s.id = ?
         GROUP BY s.id`,
      )
      .get(siteId) as
      | {
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
      }
      | undefined;

    if (!row) {
      throw new Error(`Site ${siteId} not found`);
    }

    const pendingPages = asCount(row.pending_pages);
    const deniedPages = asCount(row.denied_pages);
    const capturedPages = asCount(row.captured_pages);
    const config = JSON.parse(row.config_json) as SiteConfig;
    const runSummaryQuery = new RunSummaryQuery(this.db);
    const latestSeedRun = runSummaryQuery.getLatestRunForSite(siteId, 'seed_run');
    const latestCrawlRun = runSummaryQuery.getLatestRunForSite(siteId, 'crawl_run');

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

export interface SitePageListInput {
  siteId: number;
  page: number;
  pageSize: number;
  status?: string;
  query?: string;
  tag?: string;
  pendingReason?: string;
  discoverySource?: string;
  crawlRunId?: number;
}

export class SitePageListQuery {
  constructor(private readonly db: DatabaseSync) { }

  listPages(input: SitePageListInput): {
    total: number;
    page: number;
    pageSize: number;
    rows: Array<{
      sitePageId: number;
      title: string;
      url: string;
      businessStatus: string;
      tags: string[];
      latestOutcome: string;
      latestHandledAt: string | null;
      needsReview: boolean;
      pendingReasonLabel: string | null;
      discoverySource: string;
      captureSummary: string;
    }>;
  } {
    const filters: string[] = ['sp.site_id = ?'];
    const args: Array<number | string> = [input.siteId];

    if (input.status) {
      filters.push('sp.inventory_status = ?');
      args.push(input.status);
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

    if (input.tag) {
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
             AND prt.classification_tags_json LIKE ?
         )`,
      );
      args.push(`%${input.tag}%`);
    }

    const whereClause = filters.join(' AND ');
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS count FROM site_pages sp WHERE ${whereClause}`)
      .get(...args) as { count: number };

    const offset = (input.page - 1) * input.pageSize;
    const rows = this.db
      .prepare(
        `SELECT
           sp.id,
           sp.normalized_url,
           sp.inventory_status,
           sp.last_pending_reason,
           sp.latest_title,
           sp.discovery_source,
           COALESCE(sp.last_markdown_at, sp.last_screenshot_at, sp.last_base_at) AS latest_handled_at,
           pr.classification_tags_json,
           pr.decision_outcome,
           pr.required_artifacts_json,
           sp.last_markdown_status,
           sp.last_screenshot_status
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
      )
      .all(...args, input.pageSize, offset);

    return {
      total: totalRow.count,
      page: input.page,
      pageSize: input.pageSize,
      rows: rows.map((row) => {
        const record = row as Record<string, unknown>;
        const tags = parseJson<Record<string, string[]>>(
          (record.classification_tags_json as string | null | undefined) ?? null,
        );
        const requiredArtifacts =
          parseJson<string[]>((record.required_artifacts_json as string | null | undefined) ?? null) ??
          [];
        const markdownDone = record.last_markdown_status === 'succeeded';
        const screenshotDone = record.last_screenshot_status === 'succeeded';

        return {
          sitePageId: Number(record.id),
          title: String(record.latest_title ?? record.normalized_url),
          url: String(record.normalized_url),
          businessStatus: toInventoryStatusLabel(String(record.inventory_status)),
          tags: Object.entries(tags ?? {}).flatMap(([key, values]) =>
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
              : `${markdownDone ? 'Markdown 已生成' : 'Markdown 待定'} / ${screenshotDone ? '截图已生成' : '截图待定'}`,
        };
      }),
    };
  }
}

type ProcessingKind = 'base' | 'markdown' | 'screenshot';

interface LatestPageRunRow {
  id: number;
  crawl_run_id: number;
  title: string;
  meta_description: string;
  body_text: string;
  classification_tags_json: string;
  decision_outcome: string;
  decision_reason: string | null;
  pending_reason: string | null;
  required_artifacts_json: string;
  base_capture_status: string;
  base_capture_path: string | null;
  finished_at: string | null;
}

function hasRequiredArtifact(requiredArtifacts: string[], kind: ProcessingKind): boolean {
  return kind === 'base' || requiredArtifacts.includes(kind);
}

function buildProcessingState(input: {
  kind: ProcessingKind;
  shouldRun: boolean;
  status: string | null;
  runId: number | null;
  handledAt: string | null;
  outputPath: string | null;
  decisionOutcome: string | null;
  pendingReason: string | null;
  requiredArtifacts: string[];
  errorMessage?: string | null;
}): {
  kind: ProcessingKind;
  label: string;
  shouldRun: boolean;
  succeeded: boolean;
  status: string | null;
  statusLabel: string;
  reason: string;
  runId: number | null;
  handledAt: string | null;
  outputPath: string | null;
  errorMessage: string | null;
} {
  const succeeded = input.status === 'succeeded';
  const label =
    input.kind === 'base'
      ? '基础爬取'
      : input.kind === 'markdown'
        ? 'Markdown'
        : 'Screenshot';
  let reason = '';

  if (!input.shouldRun) {
    if (input.decisionOutcome === 'deny') {
      reason = '规则判定为不采集。';
    } else if (input.decisionOutcome === 'pending') {
      reason = toPendingReasonLabel(input.pendingReason) ?? '等待规则确认。';
    } else if (input.kind !== 'base') {
      reason = `最新规则未要求运行 ${label}。`;
    } else {
      reason = '尚未进入基础爬取。';
    }
  } else if (succeeded) {
    reason = '已成功运行。';
  } else if (input.errorMessage) {
    reason = input.errorMessage;
  } else if (input.status === 'failed') {
    reason = '运行失败。';
  } else if (input.requiredArtifacts.length > 0 || input.kind === 'base') {
    reason = '应该运行，但还没有成功记录。';
  } else {
    reason = '无需运行。';
  }

  return {
    kind: input.kind,
    label,
    shouldRun: input.shouldRun,
    succeeded,
    status: input.status,
    statusLabel: succeeded ? '已成功' : input.status === 'failed' ? '失败' : '未成功',
    reason,
    runId: input.runId,
    handledAt: input.handledAt,
    outputPath: input.outputPath,
    errorMessage: input.errorMessage ?? null,
  };
}

export class SitePageDetailQuery {
  constructor(private readonly db: DatabaseSync) { }

  getPageDetail(siteId: number, sitePageId: number): {
    sitePageId: number;
    siteId: number;
    title: string;
    url: string;
    discoveredUrl: string;
    inventoryStatus: string;
    businessStatus: string;
    discoverySource: string;
    discoveryReferrerUrl: string | null;
    firstDiscoveredAt: string;
    updatedAt: string;
    latestTags: string[];
    latestDecision: string | null;
    latestPendingReasonLabel: string | null;
    latestBase: ReturnType<typeof buildProcessingState>;
    latestMarkdown: ReturnType<typeof buildProcessingState>;
    latestScreenshot: ReturnType<typeof buildProcessingState>;
    latestPageRun: {
      pageRunId: number;
      crawlRunId: number;
      title: string;
      metaDescription: string;
      bodyText: string;
      requiredArtifacts: string[];
      decisionOutcome: string;
      decisionReason: string | null;
      pendingReasonLabel: string | null;
    } | null;
    latestPreviews: {
      base: {
        outputPath: string | null;
        content: string | null;
      };
      markdown: {
        artifactRunId: number | null;
        outputPath: string | null;
        content: string | null;
      };
      screenshot: {
        artifactRunId: number | null;
        outputPath: string | null;
      };
    };
    runHistory: Array<{
      runId: number;
      runType: string;
      runTypeLabel: string;
      statusLabel: string;
      startedAt: string;
      finishedAt: string | null;
      pageRuns: Array<{
        pageRunId: number;
        title: string;
        decisionOutcome: string;
        decisionReason: string | null;
        pendingReasonLabel: string | null;
        requiredArtifacts: string[];
        tags: string[];
        baseStatus: string;
        baseCapturePath: string | null;
        bodyPreview: string;
      }>;
      artifactRuns: Array<{
        artifactRunId: number;
        pageRunId: number;
        artifactType: string;
        status: string;
        outputPath: string | null;
        contentPreview: string;
        errorMessage: string | null;
        finishedAt: string | null;
      }>;
    }>;
  } {
    const page = this.db
      .prepare(
        `SELECT
           id,
           site_id,
           discovered_url,
           normalized_url,
           inventory_status,
           discovery_source,
           discovery_referrer_url,
           latest_title,
           last_pending_reason,
           last_base_status,
           last_base_run_id,
           last_base_at,
           last_markdown_status,
           last_markdown_run_id,
           last_markdown_at,
           last_screenshot_status,
           last_screenshot_run_id,
           last_screenshot_at,
           first_discovered_at,
           updated_at
         FROM site_pages
         WHERE site_id = ? AND id = ?`,
      )
      .get(siteId, sitePageId) as
      | {
        id: number;
        site_id: number;
        discovered_url: string;
        normalized_url: string;
        inventory_status: string;
        discovery_source: string;
        discovery_referrer_url: string | null;
        latest_title: string | null;
        last_pending_reason: string | null;
        last_base_status: string | null;
        last_base_run_id: number | null;
        last_base_at: string | null;
        last_markdown_status: string | null;
        last_markdown_run_id: number | null;
        last_markdown_at: string | null;
        last_screenshot_status: string | null;
        last_screenshot_run_id: number | null;
        last_screenshot_at: string | null;
        first_discovered_at: string;
        updated_at: string;
      }
      | undefined;

    if (!page) {
      throw new Error(`Site page ${sitePageId} not found`);
    }

    const latestPageRun =
      (this.db
        .prepare(
          `SELECT
             id,
             crawl_run_id,
             title,
             meta_description,
             body_text,
             classification_tags_json,
             decision_outcome,
             decision_reason,
             pending_reason,
             required_artifacts_json,
             base_capture_status,
             base_capture_path,
             finished_at
           FROM page_runs
           WHERE site_page_id = ?
           ORDER BY id DESC
           LIMIT 1`,
        )
        .get(sitePageId) as LatestPageRunRow | undefined) ?? null;

    const latestArtifacts = this.db
      .prepare(
        `SELECT id, artifact_type, status, output_path, content, error_message, finished_at
         FROM artifact_runs
         WHERE site_page_id = ?
         ORDER BY id DESC`,
      )
      .all(sitePageId) as Array<{
        id: number;
        artifact_type: string;
        status: string;
        output_path: string | null;
        content: string | null;
        error_message: string | null;
        finished_at: string | null;
      }>;

    const latestArtifactByType = new Map<string, (typeof latestArtifacts)[number]>();
    for (const artifact of latestArtifacts) {
      if (!latestArtifactByType.has(artifact.artifact_type)) {
        latestArtifactByType.set(artifact.artifact_type, artifact);
      }
    }

    const requiredArtifacts =
      latestPageRun === null
        ? []
        : (parseJson<string[]>(latestPageRun.required_artifacts_json) ?? []);
    const decisionOutcome = latestPageRun?.decision_outcome ?? null;
    const pendingReason = latestPageRun?.pending_reason ?? page.last_pending_reason;
    const tagsObject =
      latestPageRun === null
        ? null
        : parseJson<Record<string, string[]>>(latestPageRun.classification_tags_json);
    const tags = Object.entries(tagsObject ?? {}).flatMap(([key, values]) =>
      values.map((value) => `${key}: ${value}`),
    );
    const markdownArtifact = latestArtifactByType.get('markdown') ?? null;
    const screenshotArtifact = latestArtifactByType.get('screenshot') ?? null;

    const pageRuns = this.db
      .prepare(
        `SELECT
           pr.id,
           pr.crawl_run_id,
           pr.title,
           pr.body_text,
           pr.classification_tags_json,
           pr.decision_outcome,
           pr.decision_reason,
           pr.pending_reason,
           pr.required_artifacts_json,
           pr.base_capture_status,
           pr.base_capture_path
         FROM page_runs pr
         WHERE pr.site_page_id = ?
         ORDER BY pr.crawl_run_id DESC, pr.id DESC`,
      )
      .all(sitePageId) as Array<{
        id: number;
        crawl_run_id: number;
        title: string;
        body_text: string;
        classification_tags_json: string;
        decision_outcome: string;
        decision_reason: string | null;
        pending_reason: string | null;
        required_artifacts_json: string;
        base_capture_status: string;
        base_capture_path: string | null;
      }>;

    const artifactRuns = this.db
      .prepare(
        `SELECT
           id,
           crawl_run_id,
           page_run_id,
           artifact_type,
           status,
           output_path,
           content,
           error_message,
           finished_at
         FROM artifact_runs
         WHERE site_page_id = ?
         ORDER BY crawl_run_id DESC, id DESC`,
      )
      .all(sitePageId) as Array<{
        id: number;
        crawl_run_id: number;
        page_run_id: number;
        artifact_type: string;
        status: string;
        output_path: string | null;
        content: string | null;
        error_message: string | null;
        finished_at: string | null;
      }>;

    const runIds = Array.from(
      new Set([
        ...pageRuns.map((row) => row.crawl_run_id),
        ...artifactRuns.map((row) => row.crawl_run_id),
      ]),
    );
    const runRows =
      runIds.length === 0
        ? []
        : (this.db
          .prepare(
            `SELECT id, run_type, status, started_at, finished_at
               FROM crawl_runs
               WHERE id IN (${runIds.map(() => '?').join(',')})
               ORDER BY id DESC`,
          )
          .all(...runIds) as Array<{
            id: number;
            run_type: string;
            status: string;
            started_at: string;
            finished_at: string | null;
          }>);

    const runHistory = runRows.map((run) => ({
      runId: run.id,
      runType: run.run_type,
      runTypeLabel: toRunTypeLabel(run.run_type),
      statusLabel: toRunStatusLabel(run.status),
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      pageRuns: pageRuns
        .filter((pageRun) => pageRun.crawl_run_id === run.id)
        .map((pageRun) => {
          const pageRunTags = parseJson<Record<string, string[]>>(
            pageRun.classification_tags_json,
          ) ?? {};
          const pageRunRequiredArtifacts =
            parseJson<string[]>(pageRun.required_artifacts_json) ?? [];

          return {
            pageRunId: pageRun.id,
            title: pageRun.title,
            decisionOutcome: pageRun.decision_outcome,
            decisionReason: pageRun.decision_reason,
            pendingReasonLabel: toPendingReasonLabel(pageRun.pending_reason),
            requiredArtifacts: pageRunRequiredArtifacts,
            tags: Object.entries(pageRunTags).flatMap(([key, values]) =>
              values.map((value) => `${key}: ${value}`),
            ),
            baseStatus: pageRun.base_capture_status,
            baseCapturePath: pageRun.base_capture_path,
            bodyPreview: pageRun.body_text.slice(0, 220),
          };
        }),
      artifactRuns: artifactRuns
        .filter((artifactRun) => artifactRun.crawl_run_id === run.id)
        .map((artifactRun) => ({
          artifactRunId: artifactRun.id,
          pageRunId: artifactRun.page_run_id,
          artifactType: artifactRun.artifact_type,
          status: artifactRun.status,
          outputPath: artifactRun.output_path,
          contentPreview: (artifactRun.content ?? '').slice(0, 220),
          errorMessage: artifactRun.error_message,
          finishedAt: artifactRun.finished_at,
        })),
    }));

    return {
      sitePageId: page.id,
      siteId: page.site_id,
      title: page.latest_title ?? latestPageRun?.title ?? page.normalized_url,
      url: page.normalized_url,
      discoveredUrl: page.discovered_url,
      inventoryStatus: page.inventory_status,
      businessStatus: toInventoryStatusLabel(page.inventory_status),
      discoverySource: page.discovery_source,
      discoveryReferrerUrl: page.discovery_referrer_url,
      firstDiscoveredAt: page.first_discovered_at,
      updatedAt: page.updated_at,
      latestTags: tags,
      latestDecision: decisionOutcome,
      latestPendingReasonLabel: toPendingReasonLabel(pendingReason),
      latestBase: buildProcessingState({
        kind: 'base',
        shouldRun: latestPageRun !== null,
        status: page.last_base_status,
        runId: page.last_base_run_id,
        handledAt: page.last_base_at,
        outputPath: latestPageRun?.base_capture_path ?? null,
        decisionOutcome,
        pendingReason,
        requiredArtifacts,
      }),
      latestMarkdown: buildProcessingState({
        kind: 'markdown',
        shouldRun: decisionOutcome === 'allow' && hasRequiredArtifact(requiredArtifacts, 'markdown'),
        status: page.last_markdown_status,
        runId: page.last_markdown_run_id,
        handledAt: page.last_markdown_at,
        outputPath: markdownArtifact?.output_path ?? null,
        decisionOutcome,
        pendingReason,
        requiredArtifacts,
        errorMessage: markdownArtifact?.error_message ?? null,
      }),
      latestScreenshot: buildProcessingState({
        kind: 'screenshot',
        shouldRun: decisionOutcome === 'allow' && hasRequiredArtifact(requiredArtifacts, 'screenshot'),
        status: page.last_screenshot_status,
        runId: page.last_screenshot_run_id,
        handledAt: page.last_screenshot_at,
        outputPath: screenshotArtifact?.output_path ?? null,
        decisionOutcome,
        pendingReason,
        requiredArtifacts,
        errorMessage: screenshotArtifact?.error_message ?? null,
      }),
      latestPageRun:
        latestPageRun === null
          ? null
          : {
            pageRunId: latestPageRun.id,
            crawlRunId: latestPageRun.crawl_run_id,
            title: latestPageRun.title,
            metaDescription: latestPageRun.meta_description,
            bodyText: latestPageRun.body_text,
            requiredArtifacts,
            decisionOutcome: latestPageRun.decision_outcome,
            decisionReason: latestPageRun.decision_reason,
            pendingReasonLabel: toPendingReasonLabel(latestPageRun.pending_reason),
          },
      latestPreviews: {
        base: {
          outputPath: latestPageRun?.base_capture_path ?? null,
          content: readTextFile(latestPageRun?.base_capture_path ?? null),
        },
        markdown: {
          artifactRunId: markdownArtifact?.id ?? null,
          outputPath: markdownArtifact?.output_path ?? null,
          content: markdownArtifact?.content ?? null,
        },
        screenshot: {
          artifactRunId: screenshotArtifact?.id ?? null,
          outputPath: screenshotArtifact?.output_path ?? null,
        },
      },
      runHistory,
    };
  }

  getArtifactFile(siteId: number, artifactRunId: number): {
    artifactType: string;
    outputPath: string;
  } {
    const artifact = this.db
      .prepare(
        `SELECT ar.artifact_type, ar.output_path
         FROM artifact_runs ar
         JOIN site_pages sp ON sp.id = ar.site_page_id
         WHERE sp.site_id = ? AND ar.id = ?`,
      )
      .get(siteId, artifactRunId) as
      | {
        artifact_type: string;
        output_path: string | null;
      }
      | undefined;

    if (!artifact?.output_path || !existsSync(artifact.output_path)) {
      throw new Error(`Artifact ${artifactRunId} not found`);
    }

    return {
      artifactType: artifact.artifact_type,
      outputPath: artifact.output_path,
    };
  }
}

export class RunSummaryQuery {
  constructor(private readonly db: DatabaseSync) { }

  listSiteRuns(siteId: number): Array<{
    runId: number;
    runType: string;
    runTypeLabel: string;
    status: string;
    statusLabel: string;
    startedAt: string;
    finishedAt: string | null;
    successfulPages: number;
    pendingPages: number;
    deniedPages: number;
    targetSuccessCount: number | null;
    configSummary: ReturnType<typeof summarizeConfig>;
  }> {
    return this.db
      .prepare(
        `SELECT
           id,
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
         WHERE site_id = ?
         ORDER BY id DESC`,
      )
      .all(siteId)
      .map((row) => {
        const record = row as Record<string, unknown>;
        const config = JSON.parse(String(record.config_snapshot_json)) as SiteConfig;

        return {
          runId: Number(record.id),
          runType: String(record.run_type),
          runTypeLabel: toRunTypeLabel(String(record.run_type)),
          status: String(record.status),
          statusLabel: toRunStatusLabel(String(record.status)),
          startedAt: String(record.started_at),
          finishedAt: (record.finished_at as string | null | undefined) ?? null,
          successfulPages: Number(record.successful_page_count),
          pendingPages: Number(record.pending_page_count),
          deniedPages: Number(record.denied_page_count),
          targetSuccessCount:
            (record.target_success_count as number | null | undefined) ?? null,
          configSummary: summarizeConfig(config),
        };
      });
  }

  getLatestRunForSite(siteId: number, runType: 'seed_run' | 'crawl_run'): {
    runId: number;
    runTypeLabel: string;
    statusLabel: string;
    startedAt: string;
    finishedAt: string | null;
    successfulPages: number;
    pendingPages: number;
    deniedPages: number;
  } | null {
    return this.listSiteRuns(siteId).find((run) => run.runType === runType) ?? null;
  }

  getRunSummary(runId: number): {
    runId: number;
    siteId: number;
    runTypeLabel: string;
    statusLabel: string;
    startedAt: string;
    finishedAt: string | null;
    successfulPages: number;
    pendingPages: number;
    deniedPages: number;
    targetSuccessCount: number | null;
    configSummary: ReturnType<typeof summarizeConfig>;
    issues: string[];
  } {
    const row = this.db
      .prepare(
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
      )
      .get(runId) as
      | {
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
      }
      | undefined;

    if (!row) {
      throw new Error(`Run ${runId} not found`);
    }

    const issues: string[] = [];

    if (row.pending_page_count > 0) {
      issues.push(`本次运行后还有 ${row.pending_page_count} 个页面需要人工确认。`);
    }

    if (row.denied_page_count > 0) {
      issues.push(`有 ${row.denied_page_count} 个页面被排除在本次采集范围之外。`);
    }

    if (row.status === 'failed') {
      issues.push('运行没有完整结束，请检查站点配置或抓取日志。');
    }

    return {
      runId: row.id,
      siteId: row.site_id,
      runTypeLabel: toRunTypeLabel(row.run_type),
      statusLabel: toRunStatusLabel(row.status),
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      successfulPages: row.successful_page_count,
      pendingPages: row.pending_page_count,
      deniedPages: row.denied_page_count,
      targetSuccessCount: row.target_success_count,
      configSummary: summarizeConfig(JSON.parse(row.config_snapshot_json) as SiteConfig),
      issues,
    };
  }
}

export class PendingReviewQuery {
  constructor(private readonly db: DatabaseSync) { }

  getPendingReview(siteId: number): Array<{
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
  }> {
    const groups = this.db
      .prepare(
        `SELECT
           sp.last_pending_reason,
           COUNT(*) AS count
         FROM site_pages sp
         WHERE sp.site_id = ? AND sp.inventory_status = 'stage2_pending'
         GROUP BY sp.last_pending_reason
         ORDER BY count DESC`,
      )
      .all(siteId);

    return groups.map((group) => {
      const record = group as Record<string, unknown>;
      const reason = String(record.last_pending_reason ?? 'unknown');
      const pages = this.db
        .prepare(
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
        )
        .all(siteId, reason)
        .map((page) => {
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
    });
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
  constructor(private readonly db: DatabaseSync) { }

  listRunLogs(runId: number, sitePageId?: number): RunLogItem[] {
    const filters = ['crawl_run_id = ?'];
    const params: number[] = [runId];

    if (sitePageId !== undefined) {
      filters.push('site_page_id = ?');
      params.push(sitePageId);
    }

    const rows = this.db
      .prepare(
        `SELECT id, crawl_run_id, site_page_id, page_run_id, level, event, url, message, meta_json, created_at
         FROM run_logs
         WHERE ${filters.join(' AND ')}
         ORDER BY id ASC`,
      )
      .all(...params) as Array<{
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
      }>;

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

  getRunErrorMessage(runId: number): string | null {
    const row = this.db
      .prepare(`SELECT error_message FROM crawl_runs WHERE id = ?`)
      .get(runId) as { error_message: string | null } | undefined;
    return row?.error_message ?? null;
  }
}
