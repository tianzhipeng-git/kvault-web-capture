import type { DbClient } from '../../db/database.js';
import {
  parseArtifactRequirementsJson,
  requirementKey,
  reusableHistoricalArtifactStatus,
} from '../../domain/artifact-requirements.js';
import type { ArtifactRunStatus, UpdatePolicy } from '../../domain/types.js';

export interface RunProgress {
  successfulPages: number;
  failedPages: number;
  pendingPages: number;
  deniedPages: number;
  successfulArtifacts: number;
  failedArtifacts: number;
}

interface PageProgressRow {
  id: number;
  site_page_id: number;
  crawl_run_id: number;
  update_policy: string;
  stale_after_ms: number | null;
  run_started_at: string;
  base_capture_status: string;
  decision_outcome: string;
  required_artifacts_json: string;
}

interface ArtifactProgressRow {
  id: number;
  crawl_run_id: number;
  page_run_id: number;
  artifact_type: string;
  variant_key: string;
  config_fingerprint: string | null;
  status: string;
  finished_at: string;
  site_page_id: number;
}

function emptyProgress(): RunProgress {
  return {
    successfulPages: 0,
    failedPages: 0,
    pendingPages: 0,
    deniedPages: 0,
    successfulArtifacts: 0,
    failedArtifacts: 0,
  };
}

export async function loadRunProgress(
  db: DbClient,
  runIds: number[],
): Promise<Map<number, RunProgress>> {
  const uniqueRunIds = [...new Set(runIds)];
  const progressByRun = new Map(uniqueRunIds.map((runId) => [runId, emptyProgress()]));

  if (uniqueRunIds.length === 0) {
    return progressByRun;
  }

  const placeholders = uniqueRunIds.map(() => '?').join(', ');
  const pageRows = await db.all<PageProgressRow>(
      `SELECT
         pr.id,
         pr.site_page_id,
         pr.crawl_run_id,
         cr.update_policy,
         cr.stale_after_ms,
         cr.started_at AS run_started_at,
         pr.base_capture_status,
         pr.decision_outcome,
         pr.required_artifacts_json
       FROM page_runs pr
       INNER JOIN crawl_runs cr ON cr.id = pr.crawl_run_id
       WHERE pr.crawl_run_id IN (${placeholders})`,
      uniqueRunIds,
    );
  const artifactRows = pageRows.length === 0
    ? []
    : await db.all<ArtifactProgressRow>(
      `SELECT id, crawl_run_id, page_run_id, site_page_id, artifact_type, variant_key,
              config_fingerprint, status, finished_at
       FROM artifact_runs
       WHERE site_page_id IN (
         SELECT DISTINCT site_page_id
         FROM page_runs
         WHERE crawl_run_id IN (${placeholders})
       )
       ORDER BY id`,
      uniqueRunIds,
    );

  const artifactStatusByPageRun = new Map<number, Map<string, string>>();
  const historicalStatusBySitePage = new Map<
    number,
    Map<string, Array<{ status: ArtifactRunStatus; finishedAt: string }>>
  >();

  for (const artifact of artifactRows) {
    const progress = progressByRun.get(artifact.crawl_run_id);
    if (progress) {
      if (artifact.status === 'succeeded') {
        progress.successfulArtifacts += 1;
      } else if (artifact.status === 'failed') {
        progress.failedArtifacts += 1;
      }
    }

    const key = requirementKey({
      artifactType: artifact.artifact_type as import('../../domain/types.js').ArtifactType,
      variantKey: artifact.variant_key,
      configFingerprint: artifact.config_fingerprint,
    });
    const statuses = artifactStatusByPageRun.get(artifact.page_run_id) ?? new Map();
    statuses.set(key, artifact.status);
    artifactStatusByPageRun.set(artifact.page_run_id, statuses);
    const historical = historicalStatusBySitePage.get(artifact.site_page_id) ?? new Map();
    historical.set(key, [...(historical.get(key) ?? []), {
      status: artifact.status as ArtifactRunStatus,
      finishedAt: artifact.finished_at,
    }]);
    historicalStatusBySitePage.set(artifact.site_page_id, historical);
  }

  for (const page of pageRows) {
    const progress = progressByRun.get(page.crawl_run_id);
    if (!progress) {
      continue;
    }

    if (page.base_capture_status === 'failed') {
      progress.failedPages += 1;
      continue;
    }

    if (page.decision_outcome === 'pending') {
      progress.pendingPages += 1;
      continue;
    }

    if (page.decision_outcome === 'deny') {
      progress.deniedPages += 1;
      continue;
    }

    if (page.decision_outcome !== 'allow') {
      continue;
    }

    const requirements = parseArtifactRequirementsJson(page.required_artifacts_json);
    const currentStatuses = artifactStatusByPageRun.get(page.id);
    const historicalStatuses = historicalStatusBySitePage.get(page.site_page_id);
    const statuses = requirements.map((requirement) => {
      const key = requirementKey(requirement);
      const current = currentStatuses?.get(key);
      if (current) {
        return current;
      }
      const historical = historicalStatuses?.get(key)
        ?.findLast((candidate) => candidate.finishedAt <= page.run_started_at);
      return historical
        ? reusableHistoricalArtifactStatus({
            policy: page.update_policy as UpdatePolicy,
            status: historical.status,
            finishedAt: historical.finishedAt,
            referenceTime: page.run_started_at,
            staleAfterMs: page.stale_after_ms,
          })
        : null;
    });

    if (statuses.every((status) => status === 'succeeded')) {
      progress.successfulPages += 1;
    } else if (statuses.some((status) => status === 'failed')) {
      progress.failedPages += 1;
    }
  }

  return progressByRun;
}
