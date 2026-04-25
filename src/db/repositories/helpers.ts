import type { ArtifactRunStatus, ArtifactType, RuleOutcome } from '../../domain/types.js';

export interface RowIdResult {
  lastInsertRowid: number | bigint;
}

export function toId(result: RowIdResult): number {
  return Number(result.lastInsertRowid);
}

export function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function hasCompleteArtifactSet(input: {
  requiredArtifacts: ArtifactType[];
  artifactStatuses: Partial<Record<ArtifactType, ArtifactRunStatus | null>>;
}): boolean {
  return input.requiredArtifacts.every(
    (artifactType) => input.artifactStatuses[artifactType] === 'succeeded',
  );
}

export function deriveInventoryStatus(input: {
  pageOutcome: RuleOutcome;
  requiredArtifacts: ArtifactType[];
  artifactStatuses: Partial<Record<ArtifactType, ArtifactRunStatus | null>>;
}) {
  if (input.pageOutcome === 'deny') {
    return 'stage2_skipped';
  }

  if (input.pageOutcome === 'pending') {
    return 'stage2_pending';
  }

  return hasCompleteArtifactSet(input)
    ? 'stage2_captured'
    : input.requiredArtifacts.length === 0
      ? 'base_captured'
      : 'stage2_pending';
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
