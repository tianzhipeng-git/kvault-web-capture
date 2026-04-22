import type {
  HistoricalPageState,
  UpdatePolicy,
} from '../domain/types.js';

function isOlderThan(lastAt: string | null, now: Date, staleAfterMs: number): boolean {
  if (lastAt === null) {
    return true;
  }

  return now.getTime() - new Date(lastAt).getTime() >= staleAfterMs;
}

export function shouldEnqueueByUpdatePolicy(input: {
  policy: UpdatePolicy;
  history: HistoricalPageState | null;
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
      if (history.lastBaseStatus === null) {
        return {
          enqueue: true,
          reason: null,
        };
      }

      if (history.lastTagRuleDecision === 'allow' && history.lastMarkdownStatus !== 'succeeded') {
        return {
          enqueue: true,
          reason: 'missing required markdown artifact',
        };
      }

      if (
        history.lastTagRuleDecision === 'pending' ||
        history.lastBaseStatus === 'failed' ||
        history.lastMarkdownStatus === 'failed'
      ) {
        return {
          enqueue: true,
          reason: 'incomplete historical result',
        };
      }

      return {
        enqueue: false,
        reason: 'already captured',
      };
    case 'rerun_failed_artifacts':
      if (history.lastBaseStatus === null || history.lastBaseStatus === 'failed') {
        return {
          enqueue: true,
          reason: 'missing or failed base capture',
        };
      }

      if (history.lastMarkdownStatus === 'failed') {
        return {
          enqueue: true,
          reason: 'failed markdown artifact',
        };
      }

      return {
        enqueue: false,
        reason: 'no failed artifacts to rerun',
      };
    case 'stale_after_duration': {
      const staleAfterMs = input.staleAfterMs ?? 0;
      const now = new Date(input.nowIsoString);

      if (
        isOlderThan(history.lastBaseAt, now, staleAfterMs) ||
        (history.lastTagRuleDecision === 'allow' &&
          isOlderThan(history.lastMarkdownAt, now, staleAfterMs))
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
