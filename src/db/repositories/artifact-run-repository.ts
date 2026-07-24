import type { DbClient } from '../database.js';
import type { ArtifactRequirement, ArtifactRunStatus, ArtifactType } from '../../domain/types.js';
import type { Clock } from '../../utils/clock.js';

export class ArtifactRunRepository {
  constructor(
    private readonly db: DbClient,
    private readonly clock: Clock,
  ) {}

  async create(input: {
    runId: number;
    pageRunId: number;
    sitePageId: number;
    artifactType: ArtifactType;
    variantKey?: string;
    configFingerprint?: string | null;
    status: ArtifactRunStatus;
    content: string | null;
    outputPath: string | null;
    errorMessage: string | null;
    meta: Record<string, unknown> | null;
  }): Promise<number> {
    const now = this.clock.now();
    const result = await this.db.run(
        `INSERT INTO artifact_runs (
          crawl_run_id,
          page_run_id,
          site_page_id,
          artifact_type,
          variant_key,
          config_fingerprint,
          status,
          started_at,
          finished_at,
          output_path,
          content,
          error_message,
          meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.runId,
        input.pageRunId,
        input.sitePageId,
        input.artifactType,
        input.variantKey ?? 'default',
        input.configFingerprint ?? null,
        input.status,
        now,
        now,
        input.outputPath,
        input.content,
        input.errorMessage,
        input.meta !== null ? JSON.stringify(input.meta) : null,
      ],
    );

    return Number(result.lastInsertId);
  }

  async latestStatus(input: {
    sitePageId: number;
    requirement: ArtifactRequirement;
    runId?: number;
  }): Promise<{ status: ArtifactRunStatus; finishedAt: string } | null> {
    const row = await this.db.get<{ status: ArtifactRunStatus; finished_at: string }>(
      `SELECT status, finished_at
       FROM artifact_runs
       WHERE site_page_id = ?
         AND artifact_type = ?
         AND variant_key = ?
         AND (
           config_fingerprint = ?
           OR (config_fingerprint IS NULL AND ? IS NULL)
         )
         ${input.runId === undefined ? '' : 'AND crawl_run_id = ?'}
       ORDER BY id DESC
       LIMIT 1`,
      [
        input.sitePageId,
        input.requirement.artifactType,
        input.requirement.variantKey,
        input.requirement.configFingerprint,
        input.requirement.configFingerprint,
        ...(input.runId === undefined ? [] : [input.runId]),
      ],
    );
    return row ? { status: row.status, finishedAt: row.finished_at } : null;
  }

  async countByRun(runId: number): Promise<number> {
    const row = await this.db.get('SELECT COUNT(*) AS count FROM artifact_runs WHERE crawl_run_id = ?', [runId]) as { count: number };
    return Number(row.count);
  }
}
