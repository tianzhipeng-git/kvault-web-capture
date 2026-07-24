import { access } from 'node:fs/promises';

import type { DbClient } from '../../db/database.js';
import {
  buildProcessingState,
  hasRequiredArtifact,
  toolNameFromMeta,
  type LatestPageRunRow,
  type ProcessingKind,
} from './read-models/page-processing.js';
import {
  parseJson,
  readTextFile,
  toInventoryStatusLabel,
  toPendingReasonLabel,
  toRunStatusLabel,
  toRunTypeLabel,
} from './read-models/read-model-utils.js';
import {
  parseArtifactRequirementsJson,
  requirementKey,
} from '../../domain/artifact-requirements.js';



export { toInventoryStatusLabel, toPendingReasonLabel, toRunTypeLabel };

export { ProjectListQuery, SiteOverviewQuery, type ProjectListItem } from './read-models/project-queries.js';

export { SitePageListQuery, type SitePageListInput } from './read-models/site-page-list-query.js';

export { RunSummaryQuery } from './read-models/run-summary-query.js';

export { PendingReviewQuery, RunLogQuery, type RunLogItem } from './read-models/review-log-queries.js';

export class SitePageDetailQuery {
  constructor(private readonly db: DbClient) { }

  async getPageDetail(siteId: number, sitePageId: number): Promise<{
    sitePageId: number;
    siteId: number;
    title: string;
    url: string;
    discoveredUrl: string;
    inventoryStatus: string;
    businessStatus: string;
    discoverySource: string;
    discoveryReferrerUrl: string | null;
    firstDiscoveredAt: string;
    updatedAt: string;
    latestLabels: string[];
    latestDecision: string | null;
    latestPendingReasonLabel: string | null;
    latestBase: ReturnType<typeof buildProcessingState>;
    latestMarkdown: ReturnType<typeof buildProcessingState>;
    latestScreenshot: ReturnType<typeof buildProcessingState>;
    latestStructured: ReturnType<typeof buildProcessingState>;
    latestScreenshotVariants: Array<{
      artifactRunId: number;
      variantKey: string;
      configFingerprint: string | null;
      status: string;
      outputPath: string | null;
      errorMessage: string | null;
      toolName: string | null;
      metadata: Record<string, unknown> | null;
    }>;
    latestPageRun: {
      pageRunId: number;
      crawlRunId: number;
      title: string;
      metaDescription: string;
      bodyText: string;
      requiredArtifacts: string[];
      decisionOutcome: string;
      decisionReason: string | null;
      pendingReasonLabel: string | null;
    } | null;
    latestPreviews: {
      base: {
        outputPath: string | null;
        content: string | null;
      };
      markdown: {
        artifactRunId: number | null;
        outputPath: string | null;
        content: string | null;
      };
      screenshot: {
        artifactRunId: number | null;
        outputPath: string | null;
      };
      structured: {
        artifactRunId: number | null;
        outputPath: string | null;
        content: string | null;
      };
    };
    runHistory: Array<{
      runId: number;
      runType: string;
      runTypeLabel: string;
      statusLabel: string;
      startedAt: string;
      finishedAt: string | null;
      pageRuns: Array<{
        pageRunId: number;
        title: string;
        decisionOutcome: string;
        decisionReason: string | null;
        pendingReasonLabel: string | null;
        requiredArtifacts: string[];
        labels: string[];
        baseStatus: string;
        baseCapturePath: string | null;
        bodyPreview: string;
      }>;
      artifactRuns: Array<{
        artifactRunId: number;
        pageRunId: number;
        artifactType: string;
        variantKey: string;
        configFingerprint: string | null;
        status: string;
        outputPath: string | null;
        contentPreview: string;
        errorMessage: string | null;
        finishedAt: string | null;
      }>;
    }>;
  }> {
    const page = await this.db.get<{
        id: number;
        site_id: number;
        discovered_url: string;
        normalized_url: string;
        inventory_status: string;
        discovery_source: string;
        discovery_referrer_url: string | null;
        latest_title: string | null;
        last_pending_reason: string | null;
        last_base_status: string | null;
        last_base_run_id: number | null;
        last_base_at: string | null;
        last_markdown_status: string | null;
        last_markdown_run_id: number | null;
        last_markdown_at: string | null;
        last_screenshot_status: string | null;
        last_screenshot_run_id: number | null;
        last_screenshot_at: string | null;
        last_structured_status: string | null;
        last_structured_run_id: number | null;
        last_structured_at: string | null;
        first_discovered_at: string;
        updated_at: string;
      }>(
        `SELECT
           id,
           site_id,
           discovered_url,
           normalized_url,
           inventory_status,
           discovery_source,
           discovery_referrer_url,
           latest_title,
           last_pending_reason,
           last_base_status,
           last_base_run_id,
           last_base_at,
           last_markdown_status,
           last_markdown_run_id,
           last_markdown_at,
           last_screenshot_status,
           last_screenshot_run_id,
           last_screenshot_at,
           last_structured_status,
           last_structured_run_id,
           last_structured_at,
           first_discovered_at,
           updated_at
         FROM site_pages
         WHERE site_id = ? AND id = ?`,
      [siteId, sitePageId],
    );

    if (!page) {
      throw new Error(`Site page ${sitePageId} not found`);
    }

    const latestPageRun =
      (await this.db.get<LatestPageRunRow>(
          `SELECT
             id,
             crawl_run_id,
             title,
             meta_description,
             body_text,
             classification_labels_json,
             decision_outcome,
             decision_reason,
             pending_reason,
             required_artifacts_json,
             base_capture_status,
             base_capture_path,
             finished_at
           FROM page_runs
           WHERE site_page_id = ?
           ORDER BY id DESC
           LIMIT 1`,
        [sitePageId],
      )) ?? null;

    const latestArtifacts = await this.db.all<{
        id: number;
        artifact_type: string;
        variant_key: string;
        config_fingerprint: string | null;
        status: string;
        output_path: string | null;
        content: string | null;
        error_message: string | null;
        finished_at: string | null;
        meta_json: string | null;
      }>(
        `SELECT id, artifact_type, variant_key, config_fingerprint, status, output_path, content, error_message, finished_at, meta_json
         FROM artifact_runs
         WHERE site_page_id = ?
         ORDER BY id DESC`,
      [sitePageId],
    );

    const latestArtifactByType = new Map<string, (typeof latestArtifacts)[number]>();
    const latestArtifactByRequirement = new Map<string, (typeof latestArtifacts)[number]>();
    for (const artifact of latestArtifacts) {
      if (!latestArtifactByType.has(artifact.artifact_type)) {
        latestArtifactByType.set(artifact.artifact_type, artifact);
      }
      const key = requirementKey({
        artifactType: artifact.artifact_type as import('../../domain/types.js').ArtifactType,
        variantKey: artifact.variant_key,
        configFingerprint: artifact.config_fingerprint,
      });
      if (!latestArtifactByRequirement.has(key)) {
        latestArtifactByRequirement.set(key, artifact);
      }
    }

    const artifactRequirements =
      latestPageRun === null
        ? []
        : parseArtifactRequirementsJson(latestPageRun.required_artifacts_json);
    const requiredArtifacts = [
      ...new Set(artifactRequirements.map((requirement) => requirement.artifactType)),
    ];
    const decisionOutcome = latestPageRun?.decision_outcome ?? null;
    const pendingReason = latestPageRun?.pending_reason ?? page.last_pending_reason;
    const labelsObject =
      latestPageRun === null
        ? null
        : parseJson<Record<string, string[]>>(latestPageRun.classification_labels_json);
    const labels = Object.entries(labelsObject ?? {}).flatMap(([key, values]) =>
      values.map((value) => `${key}: ${value}`),
    );
    const markdownArtifact = latestArtifactByType.get('markdown') ?? null;
    const screenshotArtifact = latestArtifactByType.get('screenshot') ?? null;
    const structuredArtifact = latestArtifactByType.get('structured') ?? null;
    const latestBaseLog = latestPageRun === null
      ? null
      : (await this.db.get<{ meta_json: string | null }>(
          `SELECT meta_json
           FROM run_logs
           WHERE page_run_id = ? AND event = 'base_page_done'
           ORDER BY id DESC
           LIMIT 1`,
          [latestPageRun.id],
        )) ?? null;

    const pageRuns = await this.db.all<{
        id: number;
        crawl_run_id: number;
        title: string;
        body_text: string;
        classification_labels_json: string;
        decision_outcome: string;
        decision_reason: string | null;
        pending_reason: string | null;
        required_artifacts_json: string;
        base_capture_status: string;
        base_capture_path: string | null;
      }>(
        `SELECT
           pr.id,
           pr.crawl_run_id,
           pr.title,
           pr.body_text,
           pr.classification_labels_json,
           pr.decision_outcome,
           pr.decision_reason,
           pr.pending_reason,
           pr.required_artifacts_json,
           pr.base_capture_status,
           pr.base_capture_path
         FROM page_runs pr
         WHERE pr.site_page_id = ?
         ORDER BY pr.crawl_run_id DESC, pr.id DESC`,
      [sitePageId],
    );

    const artifactRuns = await this.db.all<{
        id: number;
        crawl_run_id: number;
        page_run_id: number;
        artifact_type: string;
        variant_key: string;
        config_fingerprint: string | null;
        status: string;
        output_path: string | null;
        content: string | null;
        error_message: string | null;
        finished_at: string | null;
      }>(
        `SELECT
           id,
           crawl_run_id,
           page_run_id,
           artifact_type,
           variant_key,
           config_fingerprint,
           status,
           output_path,
           content,
           error_message,
           finished_at
         FROM artifact_runs
         WHERE site_page_id = ?
         ORDER BY crawl_run_id DESC, id DESC`,
      [sitePageId],
    );

    const runIds = Array.from(
      new Set([
        ...pageRuns.map((row) => row.crawl_run_id),
        ...artifactRuns.map((row) => row.crawl_run_id),
      ]),
    );
    const runRows =
      runIds.length === 0
        ? []
        : await this.db.all<{
            id: number;
            run_type: string;
            status: string;
            started_at: string;
            finished_at: string | null;
          }>(
            `SELECT id, run_type, status, started_at, finished_at
               FROM crawl_runs
               WHERE id IN (${runIds.map(() => '?').join(',')})
               ORDER BY id DESC`,
          runIds,
        );

    const runHistory = runRows.map((run) => ({
      runId: run.id,
      runType: run.run_type,
      runTypeLabel: toRunTypeLabel(run.run_type),
      statusLabel: toRunStatusLabel(run.status),
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      pageRuns: pageRuns
        .filter((pageRun) => pageRun.crawl_run_id === run.id)
        .map((pageRun) => {
          const pageRunLabels = parseJson<Record<string, string[]>>(
            pageRun.classification_labels_json,
          ) ?? {};
          const pageRunRequiredArtifacts = [
            ...new Set(
              parseArtifactRequirementsJson(pageRun.required_artifacts_json)
                .map((requirement) => requirement.artifactType),
            ),
          ];

          return {
            pageRunId: pageRun.id,
            title: pageRun.title,
            decisionOutcome: pageRun.decision_outcome,
            decisionReason: pageRun.decision_reason,
            pendingReasonLabel: toPendingReasonLabel(pageRun.pending_reason),
            requiredArtifacts: pageRunRequiredArtifacts,
            labels: Object.entries(pageRunLabels).flatMap(([key, values]) =>
              values.map((value) => `${key}: ${value}`),
            ),
            baseStatus: pageRun.base_capture_status,
            baseCapturePath: pageRun.base_capture_path,
            bodyPreview: pageRun.body_text.slice(0, 220),
          };
        }),
      artifactRuns: artifactRuns
        .filter((artifactRun) => artifactRun.crawl_run_id === run.id)
        .map((artifactRun) => ({
          artifactRunId: artifactRun.id,
          pageRunId: artifactRun.page_run_id,
          artifactType: artifactRun.artifact_type,
          variantKey: artifactRun.variant_key,
          configFingerprint: artifactRun.config_fingerprint,
          status: artifactRun.status,
          outputPath: artifactRun.output_path,
          contentPreview: (artifactRun.content ?? '').slice(0, 220),
          errorMessage: artifactRun.error_message,
          finishedAt: artifactRun.finished_at,
        })),
    }));

    return {
      sitePageId: page.id,
      siteId: page.site_id,
      title: page.latest_title ?? latestPageRun?.title ?? page.normalized_url,
      url: page.normalized_url,
      discoveredUrl: page.discovered_url,
      inventoryStatus: page.inventory_status,
      businessStatus: toInventoryStatusLabel(page.inventory_status),
      discoverySource: page.discovery_source,
      discoveryReferrerUrl: page.discovery_referrer_url,
      firstDiscoveredAt: page.first_discovered_at,
      updatedAt: page.updated_at,
      latestLabels: labels,
      latestDecision: decisionOutcome,
      latestPendingReasonLabel: toPendingReasonLabel(pendingReason),
      latestBase: buildProcessingState({
        kind: 'base',
        shouldRun: latestPageRun !== null,
        status: page.last_base_status,
        runId: page.last_base_run_id,
        handledAt: page.last_base_at,
        outputPath: latestPageRun?.base_capture_path ?? null,
        decisionOutcome,
        pendingReason,
        requiredArtifacts,
        toolName: toolNameFromMeta(latestBaseLog?.meta_json ?? null, 'base'),
      }),
      latestMarkdown: buildProcessingState({
        kind: 'markdown',
        shouldRun: decisionOutcome === 'allow' && hasRequiredArtifact(requiredArtifacts, 'markdown'),
        status: page.last_markdown_status,
        runId: page.last_markdown_run_id,
        handledAt: page.last_markdown_at,
        outputPath: markdownArtifact?.output_path ?? null,
        decisionOutcome,
        pendingReason,
        requiredArtifacts,
        errorMessage: markdownArtifact?.error_message ?? null,
        toolName: toolNameFromMeta(markdownArtifact?.meta_json ?? null, 'markdown'),
      }),
      latestScreenshot: buildProcessingState({
        kind: 'screenshot',
        shouldRun: decisionOutcome === 'allow' && hasRequiredArtifact(requiredArtifacts, 'screenshot'),
        status: page.last_screenshot_status,
        runId: page.last_screenshot_run_id,
        handledAt: page.last_screenshot_at,
        outputPath: screenshotArtifact?.output_path ?? null,
        decisionOutcome,
        pendingReason,
        requiredArtifacts,
        errorMessage: screenshotArtifact?.error_message ?? null,
        toolName: toolNameFromMeta(screenshotArtifact?.meta_json ?? null, 'screenshot'),
      }),
      latestStructured: buildProcessingState({
        kind: 'structured',
        shouldRun: decisionOutcome === 'allow' && hasRequiredArtifact(requiredArtifacts, 'structured'),
        status: page.last_structured_status,
        runId: page.last_structured_run_id,
        handledAt: page.last_structured_at,
        outputPath: structuredArtifact?.output_path ?? null,
        decisionOutcome,
        pendingReason,
        requiredArtifacts,
        errorMessage: structuredArtifact?.error_message ?? null,
        toolName: toolNameFromMeta(structuredArtifact?.meta_json ?? null, 'structured'),
      }),
      latestScreenshotVariants: artifactRequirements
        .filter((requirement) => requirement.artifactType === 'screenshot')
        .map((requirement) => {
          const artifact = latestArtifactByRequirement.get(requirementKey(requirement));
          const meta = parseJson<Record<string, unknown>>(artifact?.meta_json ?? null);
          return {
            artifactRunId: artifact?.id ?? 0,
            variantKey: requirement.variantKey,
            configFingerprint: requirement.configFingerprint,
            status: artifact?.status ?? 'pending',
            outputPath: artifact?.output_path ?? null,
            errorMessage: artifact?.error_message ?? null,
            toolName: toolNameFromMeta(artifact?.meta_json ?? null, 'screenshot'),
            metadata: meta,
          };
        }),
      latestPageRun:
        latestPageRun === null
          ? null
          : {
            pageRunId: latestPageRun.id,
            crawlRunId: latestPageRun.crawl_run_id,
            title: latestPageRun.title,
            metaDescription: latestPageRun.meta_description,
            bodyText: latestPageRun.body_text,
            requiredArtifacts,
            decisionOutcome: latestPageRun.decision_outcome,
            decisionReason: latestPageRun.decision_reason,
            pendingReasonLabel: toPendingReasonLabel(latestPageRun.pending_reason),
          },
      latestPreviews: {
        base: {
          outputPath: latestPageRun?.base_capture_path ?? null,
          content: await readTextFile(latestPageRun?.base_capture_path ?? null),
        },
        markdown: {
          artifactRunId: markdownArtifact?.id ?? null,
          outputPath: markdownArtifact?.output_path ?? null,
          content: markdownArtifact?.content ?? null,
        },
        screenshot: {
          artifactRunId: screenshotArtifact?.id ?? null,
          outputPath: screenshotArtifact?.output_path ?? null,
        },
        structured: {
          artifactRunId: structuredArtifact?.id ?? null,
          outputPath: structuredArtifact?.output_path ?? null,
          content: structuredArtifact?.content ?? await readTextFile(structuredArtifact?.output_path ?? null),
        },
      },
      runHistory,
    };
  }

  async getArtifactFile(siteId: number, artifactRunId: number): Promise<{
    artifactType: string;
    outputPath: string;
  }> {
    const artifact = await this.db.get<{
        artifact_type: string;
        output_path: string | null;
      }>(
        `SELECT ar.artifact_type, ar.output_path
         FROM artifact_runs ar
         JOIN site_pages sp ON sp.id = ar.site_page_id
         WHERE sp.site_id = ? AND ar.id = ?`,
      [siteId, artifactRunId],
    );

    if (!artifact?.output_path) {
      throw new Error(`Artifact ${artifactRunId} not found`);
    }

    try {
      await access(artifact.output_path);
    } catch {
      throw new Error(`Artifact ${artifactRunId} not found`);
    }

    return {
      artifactType: artifact.artifact_type,
      outputPath: artifact.output_path,
    };
  }
}
