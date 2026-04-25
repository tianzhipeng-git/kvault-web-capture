import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Plus, Trash2, ChevronDown, ChevronUp } from "lucide-react";

export const createDefaultRule = (): UrlRule => ({
  name: `rule-${Date.now()}`,
  matchType: 'url',
  listType: 'whitelist',
  ruleType: 'prefix',
  values: [],
});

export type UrlRule = {
  name: string;
  matchType?: 'url';
  listType: 'blacklist' | 'scopelist' | 'whitelist';
  ruleType: 'prefix' | 'regex';
  values: string[];
  artifacts?: Array<'markdown' | 'screenshot'>;
};

export type TagRuleCondition = {
  key: string;
  op: 'any_of' | 'all_of' | 'is_empty';
  values?: string[];
};

export type TagRule = {
  name: string;
  matchType: 'tag';
  listType: 'blacklist' | 'scopelist' | 'whitelist';
  when: TagRuleCondition[];
  artifacts?: Array<'markdown' | 'screenshot'>;
};

export type Rule = UrlRule | TagRule;

export function RuleListEditor({
  rules,
  onChange,
  allowTagMatch = false,
  showArtifacts = true,
  hideAddButton = false,
}: {
  rules: Rule[];
  onChange: (rules: Rule[]) => void;
  allowTagMatch?: boolean;
  showArtifacts?: boolean;
  hideAddButton?: boolean;
}) {
  const addRule = () => {
    const newRule: UrlRule = {
      name: `rule-${Date.now()}`,
      matchType: 'url',
      listType: 'whitelist',
      ruleType: 'prefix',
      values: [],
    };
    onChange([...rules, newRule]);
  };

  const updateRule = (index: number, updatedRule: Rule) => {
    const next = [...rules];
    next[index] = updatedRule;
    onChange(next);
  };

  const removeRule = (index: number) => {
    const next = [...rules];
    next.splice(index, 1);
    onChange(next);
  };

  const moveRule = (index: number, direction: 'up' | 'down') => {
    if (direction === 'up' && index === 0) return;
    if (direction === 'down' && index === rules.length - 1) return;
    const next = [...rules];
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    onChange(next);
  };

  return (
    <div className="space-y-4">
      {rules.map((rule, i) => (
        <RuleEditorItem
          key={i} // Using index is fine here if we manage order carefully, but ideally we'd use rule.name if unique
          rule={rule}
          allowTagMatch={allowTagMatch}
          showArtifacts={showArtifacts}
          onChange={(r) => updateRule(i, r)}
          onRemove={() => removeRule(i)}
          onMoveUp={() => moveRule(i, 'up')}
          onMoveDown={() => moveRule(i, 'down')}
          isFirst={i === 0}
          isLast={i === rules.length - 1}
        />
      ))}
      {!hideAddButton && (
        <Button variant="outline" className="w-full border-dashed" onClick={addRule}>
          <Plus className="w-4 h-4 mr-2" />
          添加规则
        </Button>
      )}
    </div>
  );
}

function RuleEditorItem({
  rule,
  allowTagMatch,
  showArtifacts,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
}: {
  rule: Rule;
  allowTagMatch: boolean;
  showArtifacts: boolean;
  onChange: (rule: Rule) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  isFirst: boolean;
  isLast: boolean;
}) {
  const matchType = rule.matchType || 'url';

  const handleArtifactChange = (artifact: 'markdown' | 'screenshot', checked: boolean) => {
    const current = rule.artifacts || ['markdown']; // default
    let next: Array<'markdown' | 'screenshot'>;
    if (checked) {
      next = [...new Set([...current, artifact])];
    } else {
      next = current.filter((a) => a !== artifact);
    }
    onChange({ ...rule, artifacts: next });
  };

  return (
    <Card className="relative overflow-hidden group">
      <div className="absolute right-2 top-2 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <Button variant="ghost" size="icon" className="h-6 w-6" disabled={isFirst} onClick={onMoveUp}>
          <ChevronUp className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6" disabled={isLast} onClick={onMoveDown}>
          <ChevronDown className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={onRemove}>
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>

      <CardContent className="p-4 pt-6 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="space-y-1">
            <Label className="text-xs">规则名称 (需唯一)</Label>
            <Input
              className="h-8"
              value={rule.name}
              onChange={(e) => onChange({ ...rule, name: e.target.value })}
            />
          </div>

          {allowTagMatch && (
            <div className="space-y-1">
              <Label className="text-xs">匹配模式</Label>
              <select
                className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={matchType}
                onChange={(e) => {
                  const val = e.target.value as 'url' | 'tag';
                  if (val === 'url') {
                    onChange({
                      name: rule.name,
                      matchType: 'url',
                      listType: rule.listType,
                      ruleType: 'prefix',
                      values: [],
                      artifacts: rule.artifacts,
                    } as UrlRule);
                  } else {
                    onChange({
                      name: rule.name,
                      matchType: 'tag',
                      listType: rule.listType,
                      when: [],
                      artifacts: rule.artifacts,
                    } as TagRule);
                  }
                }}
              >
                <option value="url">URL</option>
                <option value="tag">Tag(页面打标)</option>
              </select>
            </div>
          )}

          <div className="space-y-1">
            <Label className="text-xs">规则类型 (List Type)</Label>
            <select
              className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={rule.listType}
              onChange={(e) => onChange({ ...rule, listType: e.target.value as 'blacklist' | 'scopelist' | 'whitelist' })}
            >
              <option value="scopelist">Scopelist (仅范围)</option>
              <option value="whitelist">Whitelist (强制允许)</option>
              <option value="blacklist">Blacklist (拒绝)</option>
            </select>
          </div>

          {showArtifacts && (
            <div className="space-y-1">
              <Label className="text-xs">产物 (Artifacts)</Label>
              <div className="flex gap-4 pt-1">
                <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={(rule.artifacts || ['markdown']).includes('markdown')}
                    onChange={(e) => handleArtifactChange('markdown', e.target.checked)}
                  />
                  Markdown
                </label>
                <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={(rule.artifacts || []).includes('screenshot')}
                    onChange={(e) => handleArtifactChange('screenshot', e.target.checked)}
                  />
                  截图
                </label>
              </div>
            </div>
          )}
        </div>

        {matchType === 'url' ? (
          <UrlRuleFormFields rule={rule as UrlRule} onChange={onChange as (r: UrlRule) => void} />
        ) : (
          <TagRuleFormFields rule={rule as TagRule} onChange={onChange as (r: TagRule) => void} />
        )}
      </CardContent>
    </Card>
  );
}

function UrlRuleFormFields({ rule, onChange }: { rule: UrlRule; onChange: (r: UrlRule) => void }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 items-start border-t pt-4">
      <div className="space-y-1">
        <Label className="text-xs">匹配方式 (Rule Type)</Label>
        <select
          className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          value={rule.ruleType}
          onChange={(e) => onChange({ ...rule, ruleType: e.target.value as 'prefix' | 'regex' })}
        >
          <option value="prefix">前缀匹配 (Prefix)</option>
          <option value="regex">正则匹配 (Regex)</option>
        </select>
      </div>
      <div className="space-y-1 col-span-1 md:col-span-3">
        <Label className="text-xs">匹配值 (每行一个)</Label>
        <textarea
          className="min-h-10 w-full rounded-md border border-input bg-background p-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          value={rule.values.join('\n')}
          onChange={(e) => {
            const lines = e.target.value.split('\n').map(l => l.trim()).filter(Boolean);
            onChange({ ...rule, values: lines });
          }}
          placeholder={rule.ruleType === 'prefix' ? 'https://example.com/docs/' : '^https://example\\.com/.*'}
        />
      </div>
    </div>
  );
}

function TagRuleFormFields({ rule, onChange }: { rule: TagRule; onChange: (r: TagRule) => void }) {
  const addCondition = () => {
    onChange({
      ...rule,
      when: [...(rule.when || []), { key: 'class', op: 'any_of', values: [] }]
    });
  };

  const updateCondition = (index: number, condition: TagRuleCondition) => {
    const next = [...(rule.when || [])];
    next[index] = condition;
    onChange({ ...rule, when: next });
  };

  const removeCondition = (index: number) => {
    const next = [...(rule.when || [])];
    next.splice(index, 1);
    onChange({ ...rule, when: next });
  };

  return (
    <div className="space-y-3 border-t pt-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Label className="text-xs font-semibold">标签条件 (When)</Label>
          <span className="text-muted-foreground text-xs">多个when之间是"且"的关系</span>
        </div>
        <Button variant="secondary" size="sm" className="h-7 text-xs" onClick={addCondition}>
          <Plus className="w-3 h-3 mr-1" />
          添加条件
        </Button>
      </div>

      {(!rule.when || rule.when.length === 0) && (
        <div className="text-xs text-muted-foreground text-center py-4 border border-dashed rounded-md">
          尚未添加条件。请添加条件以匹配 HTML 标签。
        </div>
      )}

      <div className="space-y-2">
        {(rule.when || []).map((cond, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_2fr_auto] gap-2 items-start bg-muted/30 p-2 rounded-md">
            <div className="space-y-1">
              <Input
                className="h-8 text-xs"
                placeholder="属性 (例如: class)"
                value={cond.key}
                onChange={(e) => updateCondition(i, { ...cond, key: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <select
                className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={cond.op}
                onChange={(e) => updateCondition(i, { ...cond, op: e.target.value as 'any_of' | 'all_of' | 'is_empty' })}
              >
                <option value="any_of">包含任意 (any_of)</option>
                <option value="all_of">包含全部 (all_of)</option>
                <option value="is_empty">为空 (is_empty)</option>
              </select>
            </div>
            <div className="space-y-1">
              {cond.op !== 'is_empty' ? (
                <Input
                  className="h-8 text-xs font-mono"
                  placeholder="匹配值 (逗号分隔)"
                  value={(cond.values || []).join(', ')}
                  onChange={(e) => {
                    const vals = e.target.value.split(',').map(v => v.trim()).filter(Boolean);
                    updateCondition(i, { ...cond, values: vals });
                  }}
                />
              ) : (
                <div className="h-8" />
              )}
            </div>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive shrink-0" onClick={() => removeCondition(i)}>
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
