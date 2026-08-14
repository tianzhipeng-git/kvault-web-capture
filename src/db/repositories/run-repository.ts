import type { DbClient } from '../database.js';
import type { ArtifactRunStatus, ArtifactType, CrawlRunCreateInput, RuleOutcome, RunStatus, SiteConfig, UpdatePolicy } from '../../domain/types.js';
import type { Clock } from '../../utils/clock.js';
import { parseJson } from './helpers.js';
import {
  parseArtifactRequirementsJson,
  requirementKey,
  reusableHistoricalArtifactStatus,
} from '../../domain/artifact-requirements.js';

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
          stale_after_ms,
          config_snapshot_json,
          status,
          started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.siteId,
        input.runType,
        input.updatePolicy,
        input.targetSuccessCount,
        input.staleAfterMs,
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
           pr.site_page_id,
           pr.decision_outcome,
           pr.required_artifacts_json,
           cr.update_policy,
           cr.stale_after_ms,
           cr.started_at AS run_started_at
         FROM page_runs pr
         INNER JOIN crawl_runs cr ON cr.id = pr.crawl_run_id
         WHERE pr.crawl_run_id = ?`,
      [runId],
    ) as Array<{
      id: number;
      site_page_id: number;
      decision_outcome: RuleOutcome;
      required_artifacts_json: string;
      update_policy: UpdatePolicy;
      stale_after_ms: number | null;
      run_started_at: string;
    }>;

    const artifactRows = pageRuns.length === 0 ? [] : await this.db.all(
        `SELECT page_run_id, site_page_id, artifact_type, variant_key, config_fingerprint,
                status, finished_at
         FROM artifact_runs
         WHERE site_page_id IN (
           SELECT site_page_id FROM page_runs WHERE crawl_run_id = ?
         )
         ORDER BY id`,
      [runId],
    ) as Array<{
      page_run_id: number;
      site_page_id: number;
      artifact_type: ArtifactType;
      variant_key: string;
      config_fingerprint: string | null;
      status: ArtifactRunStatus;
      finished_at: string;
    }>;

    const currentStatuses = new Map<number, Map<string, ArtifactRunStatus>>();
    const historicalStatuses = new Map<
      number,
      Map<string, Array<{ status: ArtifactRunStatus; finishedAt: string }>>
    >();

    for (const artifactRow of artifactRows) {
      const key = requirementKey({
        artifactType: artifactRow.artifact_type,
        variantKey: artifactRow.variant_key,
        configFingerprint: artifactRow.config_fingerprint,
      });
      const current = currentStatuses.get(artifactRow.page_run_id) ?? new Map();
      current.set(key, artifactRow.status);
      currentStatuses.set(artifactRow.page_run_id, current);
      const historical = historicalStatuses.get(artifactRow.site_page_id) ?? new Map();
      historical.set(key, [
        ...(historical.get(key) ?? []),
        { status: artifactRow.status, finishedAt: artifactRow.finished_at },
      ]);
      historicalStatuses.set(artifactRow.site_page_id, historical);
    }

    const successfulCount = pageRuns.filter((pageRun) => {
      if (pageRun.decision_outcome !== 'allow') {
        return false;
      }

      const requirements = parseArtifactRequirementsJson(pageRun.required_artifacts_json);
      return requirements.every((requirement) => {
        const key = requirementKey(requirement);
        const current = currentStatuses.get(pageRun.id)?.get(key);
        if (current) {
          return current === 'succeeded';
        }
        const historical = historicalStatuses.get(pageRun.site_page_id)?.get(key)
          ?.findLast((candidate) => candidate.finishedAt <= pageRun.run_started_at);
        return historical !== undefined && reusableHistoricalArtifactStatus({
          policy: pageRun.update_policy,
          status: historical.status,
          finishedAt: historical.finishedAt,
          referenceTime: pageRun.run_started_at,
          staleAfterMs: pageRun.stale_after_ms,
        }) === 'succeeded';
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
