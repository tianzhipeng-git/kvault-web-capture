import { parseJson, toPendingReasonLabel } from './read-model-utils.js';

export type ProcessingKind = 'base' | 'markdown' | 'screenshot' | 'structured';

export interface LatestPageRunRow {
  id: number;
  crawl_run_id: number;
  title: string;
  meta_description: string;
  body_text: string;
  classification_labels_json: string;
  decision_outcome: string;
  decision_reason: string | null;
  pending_reason: string | null;
  required_artifacts_json: string;
  base_capture_status: string;
  base_capture_path: string | null;
  finished_at: string | null;
}

export function hasRequiredArtifact(requiredArtifacts: string[], kind: ProcessingKind): boolean {
  return kind === 'base' || requiredArtifacts.includes(kind);
}

export function toolNameFromMeta(metaJson: string | null, kind?: ProcessingKind): string | null {
  if (metaJson === null) {
    return null;
  }

  const meta = parseJson<Record<string, unknown>>(metaJson);
  if (typeof meta?.tool === 'string') {
    return meta.tool;
  }
  if (typeof meta?.strategy === 'string') {
    return meta.strategy;
  }

  const diagnostics = Array.isArray(meta?.diagnostics) ? meta.diagnostics : [];
  const diagnostic = diagnostics.find((item): item is { toolName?: unknown; status?: unknown; capabilities?: unknown } => {
    if (typeof item !== 'object' || item === null) {
      return false;
    }
    const record = item as Record<string, unknown>;
    return (
      record.status === 'succeeded' &&
      Array.isArray(record.capabilities) &&
      (kind === undefined || record.capabilities.includes(kind))
    );
  });

  return typeof diagnostic?.toolName === 'string' ? diagnostic.toolName : null;
}

export function buildProcessingState(input: {
  kind: ProcessingKind;
  shouldRun: boolean;
  status: string | null;
  runId: number | null;
  handledAt: string | null;
  outputPath: string | null;
  decisionOutcome: string | null;
  pendingReason: string | null;
  requiredArtifacts: string[];
  errorMessage?: string | null;
  toolName?: string | null;
}): {
  kind: ProcessingKind;
  label: string;
  shouldRun: boolean;
  succeeded: boolean;
  status: string | null;
  statusLabel: string;
  reason: string;
  runId: number | null;
  handledAt: string | null;
  outputPath: string | null;
  errorMessage: string | null;
  toolName: string | null;
} {
  const succeeded = input.status === 'succeeded';
  const label =
    input.kind === 'base'
      ? '基础爬取'
      : input.kind === 'markdown'
        ? 'Markdown'
        : input.kind === 'screenshot'
          ? 'Screenshot'
          : 'Structured';
  let reason = '';

  if (!input.shouldRun) {
    if (input.decisionOutcome === 'deny') {
      reason = '规则判定为不采集。';
    } else if (input.decisionOutcome === 'pending') {
      reason = toPendingReasonLabel(input.pendingReason) ?? '等待规则确认。';
    } else if (input.kind !== 'base') {
      reason = `最新规则未要求运行 ${label}。`;
    } else {
      reason = '尚未进入基础爬取。';
    }
  } else if (succeeded) {
    reason = '已成功运行。';
  } else if (input.errorMessage) {
    reason = input.errorMessage;
  } else if (input.status === 'failed') {
    reason = '运行失败。';
  } else if (input.requiredArtifacts.length > 0 || input.kind === 'base') {
    reason = '应该运行，但还没有成功记录。';
  } else {
    reason = '无需运行。';
  }

  return {
    kind: input.kind,
    label,
    shouldRun: input.shouldRun,
    succeeded,
    status: input.status,
    statusLabel: succeeded ? '已成功' : input.status === 'failed' ? '失败' : '未成功',
    reason,
    runId: input.runId,
    handledAt: input.handledAt,
    outputPath: input.outputPath,
    errorMessage: input.errorMessage ?? null,
    toolName: input.toolName ?? null,
  };
}
