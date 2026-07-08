import type { DbClient } from '../database.js';
import type { ArtifactRunStatus, ArtifactType, CrawlRunCreateInput, RuleOutcome, RunStatus, SiteConfig, UpdatePolicy } from '../../domain/types.js';
import type { Clock } from '../../utils/clock.js';
import { hasCompleteArtifactSet, parseJson } from './helpers.js';

export interface CrawlRunRecord {
  id: number;
  siteId: number;
  runType: 'seed_run' | 'crawl_run';
  updatePolicy: UpdatePolicy;
  status: RunStatus;
  configSnapshot: SiteConfig;
}

export class RunRepository {
  constructor(
    private readonly db: DbClient,
    private readonly clock: Clock,
  ) {}

  async createRun(input: CrawlRunCreateInput): Promise<number> {
    const now = this.clock.now();
    const result = await this.db.run(
        `INSERT INTO crawl_runs (
          site_id,
          run_type,
          update_policy,
          target_success_count,
          config_snapshot_json,
          status,
          started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.siteId,
        input.runType,
        input.updatePolicy,
        input.targetSuccessCount,
        JSON.stringify(input.configSnapshot),
        'running',
        now,
      ],
    );

    return Number(result.lastInsertId);
  }

  async getById(runId: number): Promise<CrawlRunRecord | null> {
    const row = await this.db.get(
        `SELECT id, site_id, run_type, update_policy, status, config_snapshot_json
         FROM crawl_runs
         WHERE id = ?`,
      [runId],
    ) as
      | {
          id: number;
          site_id: number;
          run_type: 'seed_run' | 'crawl_run';
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

  async hasRunningRun(siteId: number): Promise<boolean> {
    const row = await this.db.get(
      `SELECT 1 AS found FROM crawl_runs WHERE site_id = ? AND status = 'running' LIMIT 1`,
      [siteId],
    );

    return row !== undefined;
  }

  async finishRun(runId: number, status: RunStatus, errorMessage?: string): Promise<boolean> {
    const result = await this.db.run('UPDATE crawl_runs SET status = ?, finished_at = ?, error_message = ? WHERE id = ? AND status = ?', [
      status,
      this.clock.now(),
      errorMessage ?? null,
      runId,
      'running',
    ]);
    return result.changes === null || result.changes > 0;
  }

  async refreshCounts(runId: number): Promise<void> {
    const row = await this.db.get(
        `SELECT
           SUM(CASE WHEN decision_outcome = 'deny' THEN 1 ELSE 0 END) AS denied_count,
           SUM(CASE WHEN decision_outcome = 'pending' THEN 1 ELSE 0 END) AS pending_count
         FROM page_runs
         WHERE crawl_run_id = ?`,
      [runId],
    ) as {
      denied_count: number | null;
      pending_count: number | null;
    };

    const candidateRow = await this.db.get('SELECT COUNT(*) AS count FROM page_runs WHERE crawl_run_id = ?', [runId]) as { count: number };

    const pageRuns = await this.db.all(
        `SELECT
           pr.id,
           pr.decision_outcome,
           pr.required_artifacts_json,
           sp.last_markdown_status,
           sp.last_screenshot_status
         FROM page_runs pr
         INNER JOIN site_pages sp ON sp.id = pr.site_page_id
         WHERE pr.crawl_run_id = ?`,
      [runId],
    ) as Array<{
      id: number;
      decision_outcome: RuleOutcome;
      required_artifacts_json: string;
      last_markdown_status: ArtifactRunStatus | null;
      last_screenshot_status: ArtifactRunStatus | null;
    }>;

    const artifactRows = await this.db.all(
        `SELECT page_run_id, artifact_type, status
         FROM artifact_runs
         WHERE crawl_run_id = ?`,
      [runId],
    ) as Array<{
      page_run_id: number;
      artifact_type: ArtifactType;
      status: ArtifactRunStatus;
    }>;

    const artifactStatuses = new Map<number, Partial<Record<ArtifactType, ArtifactRunStatus>>>();

    for (const artifactRow of artifactRows) {
      const current = artifactStatuses.get(artifactRow.page_run_id) ?? {};
      current[artifactRow.artifact_type] = artifactRow.status;
      artifactStatuses.set(artifactRow.page_run_id, current);
    }

    const successfulCount = pageRuns.filter((pageRun) => {
      if (pageRun.decision_outcome !== 'allow') {
        return false;
      }

      return hasCompleteArtifactSet({
        requiredArtifacts: parseJson<ArtifactType[]>(pageRun.required_artifacts_json),
        artifactStatuses: {
          markdown: pageRun.last_markdown_status,
          screenshot: pageRun.last_screenshot_status,
          ...(artifactStatuses.get(pageRun.id) ?? {}),
        },
      });
    }).length;

    await this.db.run(
        `UPDATE crawl_runs
         SET candidate_page_count = ?,
             pending_page_count = ?,
             denied_page_count = ?,
             successful_page_count = ?
         WHERE id = ?`,
      [
        Number(candidateRow.count),
        row.pending_count ?? 0,
        row.denied_count ?? 0,
        successfulCount,
        runId,
      ],
    );
  }
}
