import type {
  ArtifactType,
  HistoricalPageState,
  StageDecisionSnapshot,
  UpdatePolicy,
} from '../domain/types.js';

function isOlderThan(lastAt: string | null, now: Date, staleAfterMs: number): boolean {
  if (lastAt === null) {
    return true;
  }

  return now.getTime() - new Date(lastAt).getTime() >= staleAfterMs;
}

function getRequiredArtifacts(history: HistoricalPageState): ArtifactType[] {
  return history.lastStageDecision?.requiredArtifacts ?? [];
}

function getArtifactStatus(history: HistoricalPageState, artifactType: ArtifactType): string | null {
  if (artifactType === 'markdown') {
    return history.lastMarkdownStatus;
  }
  if (artifactType === 'screenshot') {
    return history.lastScreenshotStatus;
  }
  return history.lastStructuredStatus;
}

function getArtifactTimestamp(history: HistoricalPageState, artifactType: ArtifactType): string | null {
  if (artifactType === 'markdown') {
    return history.lastMarkdownAt;
  }
  if (artifactType === 'screenshot') {
    return history.lastScreenshotAt;
  }
  return history.lastStructuredAt;
}

function hasMissingOrFailedRequiredArtifact(history: HistoricalPageState): boolean {
  return getRequiredArtifacts(history).some((artifactType) => {
    const status = getArtifactStatus(history, artifactType);
    return status === null || status === 'failed';
  });
}

function matchesStageDecision(
  left: StageDecisionSnapshot | null,
  right: StageDecisionSnapshot | null,
): boolean {
  if (left === right) {
    return true;
  }

  if (left === null || right === null) {
    return false;
  }

  return (
    left.outcome === right.outcome &&
    left.requiredArtifacts.length === right.requiredArtifacts.length &&
    left.requiredArtifacts.every((artifactType) => right.requiredArtifacts.includes(artifactType))
  );
}

export function shouldEnqueueArtifactByUpdatePolicy(input: {
  policy: UpdatePolicy;
  history: HistoricalPageState | null;
  artifactType: ArtifactType;
  nowIsoString: string;
  staleAfterMs: number | null;
}): boolean {
  if (
    input.history === null ||
    input.history.lastBaseStatus === null ||
    input.history.lastBaseStatus === 'failed' ||
    input.history.lastStageDecision === null ||
    input.history.lastStageDecision.outcome !== 'allow'
  ) {
    return true;
  }

  switch (input.policy) {
    case 'force_recrawl_all':
      return true;
    case 'skip_existing':
      return getArtifactStatus(input.history, input.artifactType) !== 'succeeded';
    case 'stale_after_duration':
      return isOlderThan(
        getArtifactTimestamp(input.history, input.artifactType),
        new Date(input.nowIsoString),
        input.staleAfterMs ?? 0,
      );
    default: {
      const exhaustive: never = input.policy;
      return exhaustive;
    }
  }
}

// 根据历史状态, 最新rulesBeforeStage2Eq的规则结果, 判断Update Policy是否允许入队
export function shouldEnqueueByUpdatePolicy(input: {
  policy: UpdatePolicy;
  history: HistoricalPageState | null;
  currentStageDecision: StageDecisionSnapshot | null;
  nowIsoString: string;
  staleAfterMs: number | null;
}): { enqueue: boolean; reason: string | null } {
  if (input.history === null) {
    return {
      enqueue: true,
      reason: null,
    };
  }

  const history = input.history;

  switch (input.policy) {
    case 'force_recrawl_all':
      return {
        enqueue: true,
        reason: null,
      };
    case 'skip_existing':
      if (history.lastBaseStatus === null || history.lastBaseStatus !== 'succeeded') {
        return {
          enqueue: true,
          reason: null,
        };
      }

      if (!matchesStageDecision(history.lastStageDecision, input.currentStageDecision)) {
        return {
          enqueue: true,
          reason: 'config change requires reevaluation',
        };
      }

      if (history.lastStageDecision?.outcome !== 'allow') {
        return {
          enqueue: true,
          reason: 'pending or denied stage decision requires reevaluation',
        };
      }

      if (hasMissingOrFailedRequiredArtifact(history)) {
        return {
          enqueue: true,
          reason: 'missing required artifact',
        };
      }

      return {
        enqueue: false,
        reason: 'already captured',
      };
    case 'stale_after_duration': {
      const staleAfterMs = input.staleAfterMs ?? 0;
      const now = new Date(input.nowIsoString);

      if (
        isOlderThan(history.lastBaseAt, now, staleAfterMs) ||
        getRequiredArtifacts(history).some((artifactType) =>
          isOlderThan(getArtifactTimestamp(history, artifactType), now, staleAfterMs),
        )
      ) {
        return {
          enqueue: true,
          reason: 'historical result is stale',
        };
      }

      return {
        enqueue: false,
        reason: 'historical result is fresh',
      };
    }
    default: {
      const exhaustive: never = input.policy;
      return exhaustive;
    }
  }
}
