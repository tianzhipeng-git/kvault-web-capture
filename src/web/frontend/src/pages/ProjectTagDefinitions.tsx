import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChevronDown, ChevronRight, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

interface TagValueOption {
  value: string;
  description: string;
}

interface TagDefinitionCore {
  key: string;
  name: string;
  description: string;
  value_type: string;
  nullable: boolean;
  allow_extra_values: boolean;
  values_options: TagValueOption[];
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function extractOptions(source: Record<string, unknown>): TagValueOption[] {
  const valuesConfig = isRecord(source.values_config) ? source.values_config : null;
  const rawOptions = source.values_options ?? source.valuesOptions ?? valuesConfig?.options;

  if (!Array.isArray(rawOptions)) return [];

  return rawOptions
    .filter(isRecord)
    .map((option) => ({
      value: asString(option.value),
      description: asString(option.description),
    }))
    .filter((option) => option.value || option.description);
}

function extractCores(input: unknown): TagDefinitionCore[] {
  const labels = Array.isArray(input)
    ? input
    : isRecord(input) && Array.isArray(input.labels)
      ? input.labels
      : [];

  return labels.filter(isRecord).map((label) => {
    const revision = isRecord(label.revision) ? label.revision : {};
    const merged = { ...revision, ...label };
    const valuesConfig = isRecord(revision.values_config)
      ? revision.values_config
      : isRecord(label.values_config)
        ? label.values_config
        : null;

    return {
      key: asString(label.key),
      name: asString(merged.name),
      description: asString(merged.description),
      value_type: asString(merged.value_type || valuesConfig?.value_type || "single_enum"),
      nullable: asBoolean(merged.nullable, true),
      allow_extra_values: asBoolean(merged.allow_extra_values, false),
      values_options: extractOptions(merged),
    };
  }).filter((label) => label.key);
}

function buildDocument(labels: TagDefinitionCore[]) {
  return {
    version: 1,
    labels: labels.map((label) => ({
      key: label.key,
      revision: {
        name: label.name,
        description: label.description,
        value_type: label.value_type,
        values_config: {
          options: label.values_options,
          value_type: label.value_type,
        },
        nullable: label.nullable,
        allow_extra_values: label.allow_extra_values,
      },
    })),
  };
}

function createEmptyLabel(): TagDefinitionCore {
  return {
    key: "",
    name: "",
    description: "",
    value_type: "single_enum",
    nullable: true,
    allow_extra_values: false,
    values_options: [],
  };
}

export function ProjectTagDefinitions({ projectId }: { projectId: number }) {
  const [jsonDraft, setJsonDraft] = useState("");
  const [labels, setLabels] = useState<TagDefinitionCore[]>([]);
  const [expandedLabels, setExpandedLabels] = useState<Set<number>>(new Set());
  const [isSaving, setIsSaving] = useState(false);

  const hydrate = (nextDefinitions: unknown) => {
    const nextLabels = extractCores(nextDefinitions);
    setJsonDraft(pretty(nextDefinitions));
    setLabels(nextLabels);
    setExpandedLabels(new Set());
  };

  useEffect(() => {
    api.getProjectTagDefinitions(projectId).then((response) => {
      hydrate(response.tagDefinitions ?? { version: 1, labels: [] });
    });
  }, [projectId]);

  const saveDefinitions = async (nextDefinitions: unknown, successMessage: string) => {
    setIsSaving(true);
    try {
      const response = await api.updateProjectTagDefinitions(projectId, nextDefinitions);
      hydrate(response.tagDefinitions);
      toast.success(successMessage);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败。");
    } finally {
      setIsSaving(false);
    }
  };

  const updateLabel = (index: number, updates: Partial<TagDefinitionCore>) => {
    setLabels((current) => current.map((label, itemIndex) => (
      itemIndex === index ? { ...label, ...updates } : label
    )));
  };

  const updateOption = (labelIndex: number, optionIndex: number, updates: Partial<TagValueOption>) => {
    setLabels((current) => current.map((label, itemIndex) => {
      if (itemIndex !== labelIndex) return label;
      return {
        ...label,
        values_options: label.values_options.map((option, currentOptionIndex) => (
          currentOptionIndex === optionIndex ? { ...option, ...updates } : option
        )),
      };
    }));
  };

  const toggleLabel = (labelIndex: number) => {
    setExpandedLabels((current) => {
      const next = new Set(current);
      if (next.has(labelIndex)) {
        next.delete(labelIndex);
      } else {
        next.add(labelIndex);
      }
      return next;
    });
  };

  const saveForm = async () => {
    await saveDefinitions(buildDocument(labels), "标签定义已按表单内容保存。");
  };

  const saveJson = async () => {
    try {
      await saveDefinitions(JSON.parse(jsonDraft), "标签定义 JSON 已完整导入。");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "JSON 格式不正确。");
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-baseline justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle>标签定义</CardTitle>
          <CardDescription>用于网页分类的标签定义；JSON模式可完整导入`vt后台`系统导出的标签文件</CardDescription>
        </div>
        <Badge variant="outline">{labels.length} labels</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs defaultValue="form">
          <TabsList>
            <TabsTrigger value="form">表单模式</TabsTrigger>
            <TabsTrigger value="json">JSON 高级模式</TabsTrigger>
          </TabsList>

          <TabsContent value="form" className="space-y-4">
            <div className="flex justify-end">
              <Button variant="outline" className="gap-2" onClick={() => setLabels([...labels, createEmptyLabel()])}>
                <Plus className="w-4 h-4" />
                添加标签
              </Button>
            </div>

            <div className="space-y-4">
              {labels.map((label, labelIndex) => (
                <div key={`${label.key}-${labelIndex}`} className="rounded-md border bg-background">
                  <div className="grid min-h-12 grid-cols-[auto_1fr_auto_auto] items-center gap-3 px-3 py-2">
                    <Button variant="ghost" size="icon" onClick={() => toggleLabel(labelIndex)} title={expandedLabels.has(labelIndex) ? "折叠标签" : "展开标签"}>
                      {expandedLabels.has(labelIndex) ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </Button>
                    <button type="button" className="min-w-0 text-left" onClick={() => toggleLabel(labelIndex)}>
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="font-medium">{label.name || label.key || "未命名标签"}</span>
                        <Badge variant="outline" className="shrink-0">{label.value_type || "value_type"}</Badge>
                        {label.values_options.length > 0 && (
                          <span className="text-xs text-muted-foreground">{label.values_options.length} options</span>
                        )}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">{label.key || "key 未填写"}</div>
                    </button>
                    <div className="hidden max-w-[360px] truncate text-xs text-muted-foreground lg:block">
                      {label.description}
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => setLabels(labels.filter((_, itemIndex) => itemIndex !== labelIndex))} title="删除标签">
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>

                  {expandedLabels.has(labelIndex) && (
                    <div className="space-y-4 border-t p-4">
                      <div className="grid gap-3 lg:grid-cols-[1fr_1fr_180px]">
                        <div className="space-y-2">
                          <Label>key</Label>
                          <Input value={label.key} onChange={(event) => updateLabel(labelIndex, { key: event.target.value })} />
                        </div>
                        <div className="space-y-2">
                          <Label>name</Label>
                          <Input value={label.name} onChange={(event) => updateLabel(labelIndex, { name: event.target.value })} />
                        </div>
                        <div className="space-y-2">
                          <Label>value_type</Label>
                          <select className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={label.value_type} onChange={(event) => updateLabel(labelIndex, { value_type: event.target.value })}>
                            <option value="single_enum">single_enum</option>
                            <option value="multi_enum">multi_enum</option>
                            <option value="string">string</option>
                            <option value="number">number</option>
                            <option value="boolean">boolean</option>
                          </select>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label>description</Label>
                        <textarea className="min-h-[72px] w-full resize-y rounded-md border bg-background px-3 py-2 text-sm" value={label.description} onChange={(event) => updateLabel(labelIndex, { description: event.target.value })} />
                      </div>

                      <div className="flex flex-wrap gap-4 text-sm">
                        <label className="flex items-center gap-2">
                          <input type="checkbox" checked={label.nullable} onChange={(event) => updateLabel(labelIndex, { nullable: event.target.checked })} />
                          nullable
                        </label>
                        <label className="flex items-center gap-2">
                          <input type="checkbox" checked={label.allow_extra_values} onChange={(event) => updateLabel(labelIndex, { allow_extra_values: event.target.checked })} />
                          allow_extra_values
                        </label>
                      </div>

                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <Label>values_options</Label>
                          <Button variant="outline" size="sm" className="gap-2" onClick={() => updateLabel(labelIndex, { values_options: [...label.values_options, { value: "", description: "" }] })}>
                            <Plus className="w-4 h-4" />
                            添加选项
                          </Button>
                        </div>
                        {label.values_options.map((option, optionIndex) => (
                          <div key={`${label.key}-option-${optionIndex}`} className="grid gap-2 md:grid-cols-[220px_1fr_auto]">
                            <Input placeholder="value" value={option.value} onChange={(event) => updateOption(labelIndex, optionIndex, { value: event.target.value })} />
                            <Input placeholder="description" value={option.description} onChange={(event) => updateOption(labelIndex, optionIndex, { description: event.target.value })} />
                            <Button variant="ghost" size="icon" onClick={() => updateLabel(labelIndex, { values_options: label.values_options.filter((_, itemIndex) => itemIndex !== optionIndex) })} title="删除选项">
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="flex justify-end">
              <Button className="gap-2" onClick={saveForm} disabled={isSaving}>
                <Save className="w-4 h-4" />
                保存表单配置
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="json" className="space-y-4">
            <textarea className="h-[520px] w-full rounded-md border bg-muted/20 p-4 font-mono text-xs" value={jsonDraft} onChange={(event) => setJsonDraft(event.target.value)} />
            <div className="flex justify-end">
              <Button className="gap-2" onClick={saveJson} disabled={isSaving}>
                <Save className="w-4 h-4" />
                保存 JSON 配置
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
