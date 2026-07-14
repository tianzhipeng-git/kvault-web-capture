import type { DbClient } from '../../db/database.js';

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
  crawl_run_id: number;
  update_policy: string;
  base_capture_status: string;
  decision_outcome: string;
  required_artifacts_json: string;
  last_markdown_status: string | null;
  last_screenshot_status: string | null;
  last_structured_status: string | null;
}

interface ArtifactProgressRow {
  id: number;
  crawl_run_id: number;
  page_run_id: number;
  artifact_type: string;
  status: string;
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
  const [pageRows, artifactRows] = await Promise.all([
    db.all<PageProgressRow>(
      `SELECT
         pr.id,
         pr.crawl_run_id,
         cr.update_policy,
         pr.base_capture_status,
         pr.decision_outcome,
         pr.required_artifacts_json,
         sp.last_markdown_status,
         sp.last_screenshot_status,
         sp.last_structured_status
       FROM page_runs pr
       INNER JOIN crawl_runs cr ON cr.id = pr.crawl_run_id
       INNER JOIN site_pages sp ON sp.id = pr.site_page_id
       WHERE pr.crawl_run_id IN (${placeholders})`,
      uniqueRunIds,
    ),
    db.all<ArtifactProgressRow>(
      `SELECT id, crawl_run_id, page_run_id, artifact_type, status
       FROM artifact_runs
       WHERE crawl_run_id IN (${placeholders})
       ORDER BY id`,
      uniqueRunIds,
    ),
  ]);

  const artifactStatusByPageRun = new Map<number, Map<string, string>>();

  for (const artifact of artifactRows) {
    const progress = progressByRun.get(artifact.crawl_run_id);
    if (!progress) {
      continue;
    }

    if (artifact.status === 'succeeded') {
      progress.successfulArtifacts += 1;
    } else if (artifact.status === 'failed') {
      progress.failedArtifacts += 1;
    }

    const statuses = artifactStatusByPageRun.get(artifact.page_run_id) ?? new Map();
    statuses.set(artifact.artifact_type, artifact.status);
    artifactStatusByPageRun.set(artifact.page_run_id, statuses);
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

    const requiredArtifacts = JSON.parse(page.required_artifacts_json) as string[];
    const currentStatuses = artifactStatusByPageRun.get(page.id);
    const statuses = requiredArtifacts.map((artifactType) => (
      currentStatuses?.get(artifactType)
      ?? (page.update_policy === 'force_recrawl_all'
        ? null
        : artifactType === 'markdown'
          ? page.last_markdown_status
          : artifactType === 'screenshot'
            ? page.last_screenshot_status
            : page.last_structured_status)
    ));

    if (statuses.every((status) => status === 'succeeded')) {
      progress.successfulPages += 1;
    } else if (statuses.some((status) => status === 'failed')) {
      progress.failedPages += 1;
    }
  }

  return progressByRun;
}
