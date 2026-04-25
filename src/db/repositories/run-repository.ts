import type { DatabaseSync } from 'node:sqlite';
import type { ArtifactRunStatus, ArtifactType, CrawlRunCreateInput, RuleOutcome, RunStatus, SiteConfig, UpdatePolicy } from '../../domain/types.js';
import type { Clock } from '../../utils/clock.js';
import { type RowIdResult, hasCompleteArtifactSet, parseJson, toId } from './helpers.js';

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
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  createRun(input: CrawlRunCreateInput): number {
    const now = this.clock.now();
    const result = this.db
      .prepare(
        `INSERT INTO crawl_runs (
          site_id,
          run_type,
          update_policy,
          target_success_count,
          config_snapshot_json,
          status,
          started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.siteId,
        input.runType,
        input.updatePolicy,
        input.targetSuccessCount,
        JSON.stringify(input.configSnapshot),
        'running',
        now,
      ) as RowIdResult;

    return toId(result);
  }

  getById(runId: number): CrawlRunRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, site_id, run_type, update_policy, status, config_snapshot_json
         FROM crawl_runs
         WHERE id = ?`,
      )
      .get(runId) as
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

  finishRun(runId: number, status: RunStatus, errorMessage?: string): void {
    this.db
      .prepare('UPDATE crawl_runs SET status = ?, finished_at = ?, error_message = ? WHERE id = ?')
      .run(status, this.clock.now(), errorMessage ?? null, runId);
  }

  refreshCounts(runId: number): void {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN decision_outcome = 'deny' THEN 1 ELSE 0 END) AS denied_count,
           SUM(CASE WHEN decision_outcome = 'pending' THEN 1 ELSE 0 END) AS pending_count
         FROM page_runs
         WHERE crawl_run_id = ?`,
      )
      .get(runId) as {
      denied_count: number | null;
      pending_count: number | null;
    };

    const candidateRow = this.db
      .prepare('SELECT COUNT(*) AS count FROM page_runs WHERE crawl_run_id = ?')
      .get(runId) as { count: number };

    const pageRuns = this.db
      .prepare(
        `SELECT
           pr.id,
           pr.decision_outcome,
           pr.required_artifacts_json,
           sp.last_markdown_status,
           sp.last_screenshot_status
         FROM page_runs pr
         INNER JOIN site_pages sp ON sp.id = pr.site_page_id
         WHERE pr.crawl_run_id = ?`,
      )
      .all(runId) as Array<{
      id: number;
      decision_outcome: RuleOutcome;
      required_artifacts_json: string;
      last_markdown_status: ArtifactRunStatus | null;
      last_screenshot_status: ArtifactRunStatus | null;
    }>;

    const artifactRows = this.db
      .prepare(
        `SELECT page_run_id, artifact_type, status
         FROM artifact_runs
         WHERE crawl_run_id = ?`,
      )
      .all(runId) as Array<{
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

    this.db
      .prepare(
        `UPDATE crawl_runs
         SET candidate_page_count = ?,
             pending_page_count = ?,
             denied_page_count = ?,
             successful_page_count = ?
         WHERE id = ?`,
      )
      .run(
        candidateRow.count,
        row.pending_count ?? 0,
        row.denied_count ?? 0,
        successfulCount,
        runId,
      );
  }
}

