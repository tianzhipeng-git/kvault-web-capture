import type { DbClient } from '../database.js';
import type { ArtifactRunStatus, ArtifactType } from '../../domain/types.js';
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
          status,
          started_at,
          finished_at,
          output_path,
          content,
          error_message,
          meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.runId,
        input.pageRunId,
        input.sitePageId,
        input.artifactType,
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

  async countByRun(runId: number): Promise<number> {
    const row = await this.db.get('SELECT COUNT(*) AS count FROM artifact_runs WHERE crawl_run_id = ?', [runId]) as { count: number };
    return Number(row.count);
  }
}
