export type RulePreviewResult = {
  baseDecision: {
    enqueue: boolean;
    urlRuleDecision: string;
    reason: string | null;
    matchedRuleNames: string[];
  };
  stage2Decision: {
    ruleOutcome: string;
    pageOutcome: string;
    requiredArtifacts: string[];
    reason: string | null;
    pendingReason: string | null;
    matchedRuleNames: string[];
  };
};

/** 将 ["key: value", ...] 格式的 labels 数组转成 Record<string, string[]> */
export function labelsArrayToRecord(labels: string[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const label of labels) {
    const idx = label.indexOf(': ');
    if (idx === -1) continue;
    const key = label.slice(0, idx);
    const value = label.slice(idx + 2);
    (result[key] ??= []).push(value);
  }
  return result;
}

export function RulePreviewResultGrid({ result }: { result: RulePreviewResult }) {
  const outcomeClass = (outcome: string) =>
    outcome === 'allow'
      ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
      : outcome === 'deny'
        ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
        : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400';

  return (
    <div className="grid gap-3 sm:grid-cols-2 w-full min-w-0">
      <div className="rounded-md border p-3 space-y-1.5 min-w-0 overflow-hidden">
        <div className="text-xs font-semibold text-muted-foreground">基础入队规则 (rulesBeforeBaseEq)</div>
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${outcomeClass(result.baseDecision.enqueue ? 'allow' : 'deny')}`}>
          {result.baseDecision.enqueue ? '入队 (allow)' : '拒绝 (deny)'}
        </span>
        {result.baseDecision.reason && <div className="text-xs text-muted-foreground">原因：{result.baseDecision.reason}</div>}
        {result.baseDecision.matchedRuleNames.length > 0 && <div className="text-xs text-muted-foreground">命中：{result.baseDecision.matchedRuleNames.join(', ')}</div>}
      </div>
      <div className="rounded-md border p-3 space-y-1.5 min-w-0 overflow-hidden">
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${outcomeClass(result.stage2Decision.pageOutcome)}`}>
          {result.stage2Decision.pageOutcome === 'allow'
            ? '允许采集 (allow)'
            : result.stage2Decision.pageOutcome === 'deny'
              ? '拒绝 (deny)'
              : '待定 (pending)'}
        </span>
        {result.stage2Decision.requiredArtifacts.length > 0 && <div className="text-xs text-muted-foreground">产物：{result.stage2Decision.requiredArtifacts.join(', ')}</div>}
        {result.stage2Decision.reason && <div className="text-xs text-muted-foreground">原因：{result.stage2Decision.reason}</div>}
        {result.stage2Decision.matchedRuleNames.length > 0 && <div className="text-xs text-muted-foreground">命中：{result.stage2Decision.matchedRuleNames.join(', ')}</div>}
      </div>
    </div>
  );
}
