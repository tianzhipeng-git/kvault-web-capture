import type { DatabaseSync } from 'node:sqlite';
import type { ArtifactType, BaseCaptureStatus, RuleOutcome } from '../../domain/types.js';
import type { Clock } from '../../utils/clock.js';
import { type RowIdResult, toId } from './helpers.js';
import type { SampleCaptureRow } from './site-page-repository.js';

export class PageRunRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  create(input: {
    runId: number;
    sitePageId: number;
    baseCaptureStatus: BaseCaptureStatus;
    baseCapturePath: string | null;
    title: string;
    metaDescription: string;
    bodyText: string;
    classificationLabels: Record<string, string[]>;
    ruleOutcome: RuleOutcome;
    decisionOutcome: RuleOutcome;
    decisionReason: string | null;
    pendingReason: string | null;
    requiredArtifacts: ArtifactType[];
  }): number {
    const now = this.clock.now();
    const result = this.db
      .prepare(
        `INSERT INTO page_runs (
          crawl_run_id,
          site_page_id,
          started_at,
          finished_at,
          base_capture_status,
          base_capture_path,
          title,
          meta_description,
          body_text,
          classification_labels_json,
          rule_outcome,
          decision_outcome,
          decision_reason,
          pending_reason,
          required_artifacts_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.sitePageId,
        now,
        now,
        input.baseCaptureStatus,
        input.baseCapturePath,
        input.title,
        input.metaDescription,
        input.bodyText,
        JSON.stringify(input.classificationLabels),
        input.ruleOutcome,
        input.decisionOutcome,
        input.decisionReason,
        input.pendingReason,
        JSON.stringify(input.requiredArtifacts),
      ) as RowIdResult;

    return toId(result);
  }

  countByRun(runId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM page_runs WHERE crawl_run_id = ?')
      .get(runId) as { count: number };
    return row.count;
  }

  /**
   * Records a failed base-capture request.  This mirrors `create()` but marks
   * the page as failed and stores the error message rather than page content.
   */
  createFailed(input: {
    runId: number;
    sitePageId: number;
    errorMessage: string;
  }): number {
    const now = this.clock.now();
    const result = this.db
      .prepare(
        `INSERT INTO page_runs (
          crawl_run_id,
          site_page_id,
          started_at,
          finished_at,
          base_capture_status,
          base_capture_path,
          title,
          meta_description,
          body_text,
          classification_labels_json,
          rule_outcome,
          decision_outcome,
          decision_reason,
          pending_reason,
          required_artifacts_json,
          error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.sitePageId,
        now,
        now,
        'failed',
        null,
        '',
        '',
        '',
        '{}',
        'deny',
        'deny',
        null,
        null,
        '[]',
        input.errorMessage,
      ) as RowIdResult;

    return toId(result);
  }

  listSampleCaptures(siteId: number, limit: number): SampleCaptureRow[] {
    return this.db
      .prepare(
        `SELECT sp.normalized_url, pr.base_capture_path, pr.title, pr.meta_description, pr.body_text
         FROM page_runs pr
         INNER JOIN site_pages sp ON sp.id = pr.site_page_id
         WHERE sp.site_id = ?
         ORDER BY pr.id DESC
         LIMIT ?`,
      )
      .all(siteId, limit)
      .map((row) => ({
        normalizedUrl: String((row as Record<string, unknown>).normalized_url),
        baseCapturePath:
          ((row as Record<string, unknown>).base_capture_path as string | null | undefined) ??
          null,
        title: String((row as Record<string, unknown>).title),
        metaDescription: String((row as Record<string, unknown>).meta_description),
        bodyText: String((row as Record<string, unknown>).body_text),
      }));
  }
}

