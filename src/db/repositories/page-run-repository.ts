import type { DbClient } from '../database.js';
import type { ArtifactRequirement, ArtifactType, BaseCaptureStatus, RuleOutcome } from '../../domain/types.js';
import { defaultArtifactRequirement } from '../../domain/artifact-requirements.js';
import type { Clock } from '../../utils/clock.js';
import type { SampleCaptureRow } from './site-page-repository.js';

export class PageRunRepository {
  constructor(
    private readonly db: DbClient,
    private readonly clock: Clock,
  ) {}

  async create(input: {
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
    requiredArtifacts: ArtifactRequirement[] | ArtifactType[];
  }): Promise<number> {
    const now = this.clock.now();
    const result = await this.db.run(
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
      [
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
        JSON.stringify(input.requiredArtifacts.map((artifact) =>
          typeof artifact === 'string' ? defaultArtifactRequirement(artifact) : artifact,
        )),
      ],
    );

    return Number(result.lastInsertId);
  }

  async countByRun(runId: number): Promise<number> {
    const row = await this.db.get('SELECT COUNT(*) AS count FROM page_runs WHERE crawl_run_id = ?', [runId]) as { count: number };
    return Number(row.count);
  }

  async getLatestSuccessfulBase(siteId: number, sitePageId: number): Promise<{
    pageRunId: number;
    url: string;
    title: string;
    metaDescription: string;
    bodyText: string;
  } | null> {
    const row = await this.db.get<{
      id: number;
      normalized_url: string;
      title: string;
      meta_description: string;
      body_text: string;
    }>(
      `SELECT pr.id, sp.normalized_url, pr.title, pr.meta_description, pr.body_text
       FROM page_runs pr
       INNER JOIN site_pages sp ON sp.id = pr.site_page_id
       WHERE sp.site_id = ?
         AND sp.id = ?
         AND pr.base_capture_status = 'succeeded'
       ORDER BY pr.id DESC
       LIMIT 1`,
      [siteId, sitePageId],
    );

    return row
      ? {
          pageRunId: row.id,
          url: row.normalized_url,
          title: row.title,
          metaDescription: row.meta_description,
          bodyText: row.body_text,
        }
      : null;
  }

  /**
   * Records a failed base-capture request.  This mirrors `create()` but marks
   * the page as failed and stores the error message rather than page content.
   */
  async createFailed(input: {
    runId: number;
    sitePageId: number;
    errorMessage: string;
  }): Promise<number> {
    const now = this.clock.now();
    const result = await this.db.run(
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
      [
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
      ],
    );

    return Number(result.lastInsertId);
  }

  async listSampleCaptures(siteId: number, limit: number): Promise<SampleCaptureRow[]> {
    const rows = await this.db.all(
        `SELECT sp.normalized_url, pr.base_capture_path, pr.title, pr.meta_description, pr.body_text
         FROM page_runs pr
         INNER JOIN site_pages sp ON sp.id = pr.site_page_id
         WHERE sp.site_id = ?
         ORDER BY pr.id DESC
         LIMIT ?`,
      [siteId, limit],
    );
    return rows.map((row) => ({
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
