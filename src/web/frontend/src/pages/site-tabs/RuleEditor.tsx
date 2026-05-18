import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Plus, Trash2, ChevronDown, ChevronUp, ChevronRight, WandSparkles } from "lucide-react";

type ListType = 'blacklist' | 'scopelist' | 'whitelist';

export const createDefaultRule = (listType: ListType = 'whitelist'): UrlRule => ({
  name: `rule-${Date.now()}`,
  matchType: 'url',
  listType,
  ruleType: 'prefix',
  values: [],
});

export type UrlRule = {
  name: string;
  matchType?: 'url';
  listType: ListType;
  ruleType: 'prefix' | 'regex';
  values: string[];
  artifacts?: Array<'markdown' | 'screenshot'>;
};

export type LabelRuleCondition = {
  key: string;
  op: 'any_of' | 'all_of' | 'is_empty';
  values?: string[];
};

export type LabelRule = {
  name: string;
  matchType: 'label';
  listType: ListType;
  when: LabelRuleCondition[];
  artifacts?: Array<'markdown' | 'screenshot'>;
};

export type Rule = UrlRule | LabelRule;

function RuleDescriptionText({ rule, showArtifacts }: { rule: Rule; showArtifacts: boolean }) {
  const matchType = rule.matchType ?? 'url';

  if (matchType === 'url') {
    const urlRule = rule as UrlRule;
    const ruleTypeText = urlRule.ruleType === 'prefix' ? 'URL前缀是' : 'URL匹配正则';
    const vals = urlRule.values;
    const valsSummary = vals.length === 0
      ? '(未配置)'
      : vals.slice(0, 3).map(v => `"${v}"`).join(', ') + (vals.length > 3 ? ', …' : '');

    if (urlRule.listType === 'blacklist') {
      return <span>{ruleTypeText} <code className="text-xs bg-muted px-1 rounded">{valsSummary}</code> 的网址，直接<strong>丢弃</strong></span>;
    }
    const arts = showArtifacts && urlRule.artifacts?.length
      ? urlRule.artifacts.map(a => a === 'markdown' ? 'Markdown' : '截图').join('/')
      : '';
    if (urlRule.listType === 'whitelist') {
      return <span><strong>仅限</strong> {ruleTypeText} <code className="text-xs bg-muted px-1 rounded">{valsSummary}</code> 的网址<strong>强制允许</strong>{arts ? <>，采集 <strong>{arts}</strong></> : ''}</span>;
    }
    return <span><strong>仅限</strong> {ruleTypeText} <code className="text-xs bg-muted px-1 rounded">{valsSummary}</code> 的网址<strong>可以入队</strong></span>;
  }

  const labelRule = rule as LabelRule;
  const conditions = labelRule.when || [];
  const condSummary = conditions.length === 0
    ? '(未配置条件)'
    : conditions.map(c => {
        if (c.op === 'is_empty') return `${c.key}为空`;
        const opText = c.op === 'any_of' ? 'anyof' : 'allof';
        const valsStr = (c.values || []).slice(0, 3).map(v => `"${v}"`).join('/') + ((c.values || []).length > 3 ? '/…' : '');
        return `${c.key}取值是${opText} ${valsStr}`;
      }).join(' 且 ');
  const arts = showArtifacts && labelRule.artifacts?.length
    ? labelRule.artifacts.map(a => a === 'markdown' ? 'Markdown' : '截图').join('/')
    : '';

  if (labelRule.listType === 'blacklist') {
    return <span>标签满足 <code className="text-xs bg-muted px-1 rounded">{condSummary}</code>，则<strong>丢弃</strong></span>;
  }
  return <span>标签满足 <code className="text-xs bg-muted px-1 rounded">{condSummary}</code>，则<strong>入队{arts ? `采集"${arts}"` : ''}</strong></span>;
}

export function RuleListEditor({
  rules,
  onChange,
  allowLabelMatch = false,
  showArtifacts = true,
  hideAddButton = false,
  allowedListTypes = ['scopelist', 'whitelist', 'blacklist'],
  onAssistRule,
}: {
  rules: Rule[];
  onChange: (rules: Rule[]) => void;
  allowLabelMatch?: boolean;
  showArtifacts?: boolean;
  hideAddButton?: boolean;
  allowedListTypes?: ListType[];
  onAssistRule?: (rule: Rule, index: number) => void;
}) {
  const addRule = () => {
    const newRule: UrlRule = {
      name: `rule-${Date.now()}`,
      matchType: 'url',
      listType: allowedListTypes[0] ?? 'scopelist',
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
          allowLabelMatch={allowLabelMatch}
          showArtifacts={showArtifacts}
          allowedListTypes={allowedListTypes}
          onChange={(r) => updateRule(i, r)}
          onRemove={() => removeRule(i)}
          onMoveUp={() => moveRule(i, 'up')}
          onMoveDown={() => moveRule(i, 'down')}
          onAssist={onAssistRule ? () => onAssistRule(rule, i) : undefined}
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
  allowLabelMatch,
  showArtifacts,
  allowedListTypes,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  onAssist,
  isFirst,
  isLast,
}: {
  rule: Rule;
  allowLabelMatch: boolean;
  showArtifacts: boolean;
  allowedListTypes: ListType[];
  onChange: (rule: Rule) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onAssist?: () => void;
  isFirst: boolean;
  isLast: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const matchType = rule.matchType || 'url';
  const selectedListType = allowedListTypes.includes(rule.listType) ? rule.listType : (allowedListTypes[0] ?? 'scopelist');

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
      <div
        className="absolute right-2 top-2 flex flex-col gap-1 z-10"
        onClick={(e) => e.stopPropagation()}
      >
        <Button variant="ghost" size="icon" className="h-6 w-6" disabled={isFirst} onClick={onMoveUp}>
          <ChevronUp className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6" disabled={isLast} onClick={onMoveDown}>
          <ChevronDown className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={onRemove}>
          <Trash2 className="w-4 h-4" />
        </Button>
        {onAssist && (
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onAssist}>
            <WandSparkles className="w-4 h-4" />
          </Button>
        )}
      </div>

      <div
        className="flex items-center gap-2 p-3 pr-10 cursor-pointer select-none hover:bg-muted/30"
        onClick={() => setExpanded(!expanded)}
      >
        <ChevronRight className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} />
        <span className="font-medium text-sm shrink-0">{rule.name}</span>
        <div className="text-xs text-muted-foreground flex-1 min-w-0 truncate">
          <RuleDescriptionText rule={rule} showArtifacts={showArtifacts} />
        </div>
      </div>

      {expanded && (
        <CardContent className="p-4 pt-4 pr-10 space-y-4 border-t">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="space-y-1">
              <Label className="text-xs">规则名称 (需唯一)</Label>
              <Input
                className="h-8"
                value={rule.name}
                onChange={(e) => onChange({ ...rule, name: e.target.value })}
              />
            </div>

            {allowLabelMatch && (
              <div className="space-y-1">
                <Label className="text-xs">匹配模式</Label>
                <select
                  className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={matchType}
                  onChange={(e) => {
                    const val = e.target.value as 'url' | 'label';
                    if (val === 'url') {
                      onChange({
                        name: rule.name,
                        matchType: 'url',
                        listType: selectedListType,
                        ruleType: 'prefix',
                        values: [],
                        artifacts: rule.artifacts,
                      } as UrlRule);
                    } else {
                      onChange({
                        name: rule.name,
                        matchType: 'label',
                        listType: selectedListType,
                        when: [],
                        artifacts: rule.artifacts,
                      } as LabelRule);
                    }
                  }}
                >
                  <option value="url">URL</option>
                  <option value="label">Label(页面打标)</option>
                </select>
              </div>
            )}

            <div className="space-y-1">
              <Label className="text-xs">规则类型 (List Type)</Label>
              <select
                className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={selectedListType}
                onChange={(e) => onChange({ ...rule, listType: e.target.value as ListType })}
              >
                {allowedListTypes.includes('scopelist') && <option value="scopelist">Scopelist (仅范围)</option>}
                {allowedListTypes.includes('whitelist') && <option value="whitelist">Whitelist (强制允许)</option>}
                {allowedListTypes.includes('blacklist') && <option value="blacklist">Blacklist (拒绝)</option>}
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
            <LabelRuleFormFields rule={rule as LabelRule} onChange={onChange as (r: LabelRule) => void} />
          )}
        </CardContent>
      )}
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
          placeholder={rule.ruleType === 'prefix' ? 'example.com/docs/' : '^example\\.com/.*'}
        />
      </div>
    </div>
  );
}

function LabelRuleFormFields({ rule, onChange }: { rule: LabelRule; onChange: (r: LabelRule) => void }) {
  const addCondition = () => {
    onChange({
      ...rule,
      when: [...(rule.when || []), { key: 'class', op: 'any_of', values: [] }]
    });
  };

  const updateCondition = (index: number, condition: LabelRuleCondition) => {
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
                <LabelConditionValuesInput
                  values={cond.values || []}
                  onChange={(values) => updateCondition(i, { ...cond, values })}
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

function LabelConditionValuesInput({
  values,
  onChange,
}: {
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const parseValues = (value: string) => value.split(',').map(v => v.trim()).filter(Boolean);

  return (
    <Input
      className="h-8 text-xs font-mono"
      placeholder="匹配值 (逗号分隔)"
      defaultValue={values.join(', ')}
      onChange={(e) => {
        onChange(parseValues(e.target.value));
      }}
      onBlur={(e) => {
        e.currentTarget.value = parseValues(e.currentTarget.value).join(', ');
      }}
    />
  );
}
