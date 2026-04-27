type UrlRule = {
  name: string;
  matchType?: "url";
  listType: "blacklist" | "scopelist" | "whitelist";
  ruleType: "prefix" | "regex";
  values: string[];
  artifacts?: Array<"markdown" | "screenshot">;
};

type LabelRuleCondition = {
  key: string;
  op: "any_of" | "all_of" | "is_empty";
  values?: string[];
};

type LabelRule = {
  name: string;
  matchType: "label";
  listType: "blacklist" | "scopelist" | "whitelist";
  when: LabelRuleCondition[];
  artifacts?: Array<"markdown" | "screenshot">;
};

export type Rule = UrlRule | LabelRule;

export interface RuleAssistantSuggestion {
  op: "update" | "create";
  rule_name: string;
  point: "rulesBeforeBaseEq" | "rulesBeforeStage2Eq";
  rule_obj: Rule;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function extractValuesOptions(source: Record<string, unknown>): unknown[] {
  const valuesConfig = isRecord(source.values_config) ? source.values_config : null;
  const rawOptions =
    source.values_options ??
    source.valuesOptions ??
    (valuesConfig ? valuesConfig.options : undefined);

  return Array.isArray(rawOptions) ? rawOptions : [];
}

export function labelDefinitionsToJsonl(input: unknown): string {
  const rawLabels = Array.isArray(input)
    ? input
    : isRecord(input) && Array.isArray(input.labels)
      ? input.labels
      : [];

  return rawLabels
    .filter(isRecord)
    .map((label) => {
      const revision = isRecord(label.revision) ? label.revision : {};
      const merged = { ...revision, ...label };
      return {
        key: asString(label.key).trim(),
        name: asString(merged.name).trim(),
        values_options: extractValuesOptions(merged),
      };
    })
    .filter((label) => label.key.length > 0)
    .map((label) => JSON.stringify(label))
    .join("\n");
}

export function parseAssistantJson<T>(content: string): T {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidates = [
    trimmed,
    fenced?.[1],
    extractJsonCandidate(trimmed, "[", "]"),
    extractJsonCandidate(trimmed, "{", "}"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // try next candidate
    }
  }

  throw new Error("助手返回的内容不是有效 JSON。");
}

function extractJsonCandidate(content: string, open: string, close: string): string | null {
  const start = content.indexOf(open);
  const end = content.lastIndexOf(close);

  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  return content.slice(start, end + 1);
}

export function applyRuleAssistantSuggestions(input: {
  rulesBeforeBaseEq: Rule[];
  rulesBeforeStage2Eq: Rule[];
  suggestions: RuleAssistantSuggestion[];
}): {
  rulesBeforeBaseEq: Rule[];
  rulesBeforeStage2Eq: Rule[];
  appliedCount: number;
} {
  const next = {
    rulesBeforeBaseEq: [...input.rulesBeforeBaseEq],
    rulesBeforeStage2Eq: [...input.rulesBeforeStage2Eq],
  };
  let appliedCount = 0;

  for (const suggestion of input.suggestions) {
    if (
      !suggestion ||
      (suggestion.op !== "update" && suggestion.op !== "create") ||
      (suggestion.point !== "rulesBeforeBaseEq" && suggestion.point !== "rulesBeforeStage2Eq") ||
      !suggestion.rule_obj
    ) {
      continue;
    }

    const rules = next[suggestion.point];
    const ruleName = suggestion.rule_name || suggestion.rule_obj.name;

    if (suggestion.op === "update") {
      const index = rules.findIndex((rule) => rule.name === ruleName);
      if (index >= 0) {
        rules[index] = suggestion.rule_obj;
      } else {
        rules.push(suggestion.rule_obj);
      }
    } else {
      rules.push(suggestion.rule_obj);
    }

    appliedCount += 1;
  }

  return {
    ...next,
    appliedCount,
  };
}
