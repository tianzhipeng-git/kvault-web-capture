import type { DatabaseSync } from 'node:sqlite';
import type { ArtifactRunStatus, ArtifactType } from '../../domain/types.js';
import type { Clock } from '../../utils/clock.js';
import { type RowIdResult, toId } from './helpers.js';

export class ArtifactRunRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  create(input: {
    runId: number;
    pageRunId: number;
    sitePageId: number;
    artifactType: ArtifactType;
    status: ArtifactRunStatus;
    content: string | null;
    outputPath: string | null;
    errorMessage: string | null;
    meta: Record<string, unknown> | null;
  }): number {
    const now = this.clock.now();
    const result = this.db
      .prepare(
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
      )
      .run(
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
      ) as RowIdResult;

    return toId(result);
  }

  countByRun(runId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM artifact_runs WHERE crawl_run_id = ?')
      .get(runId) as { count: number };
    return row.count;
  }
}

