import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { SitePageListRow } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Copy, Save, Play, Plus, Search, WandSparkles } from "lucide-react";
import { toast } from "sonner";
import { LLMChatPanel } from "@/components/LLMChatPanel";
import type { LlmChatMessage } from "@/lib/api";
import {
  applyRuleAssistantSuggestions,
  parseAssistantJson,
  labelDefinitionsToJsonl,
  type RuleAssistantSuggestion,
} from "@/lib/rule-assistant";
import { RuleListEditor, type Rule, createDefaultRule } from "./RuleEditor";
import { RulePreviewResultGrid, labelsArrayToRecord, type RulePreviewResult } from "@/components/RulePreview";
import { CaptureConfigEditor } from "./CaptureConfigEditor";
import {
  captureConfigFromApi,
  captureConfigToApi,
  type CaptureConfigFormState,
  type SiteConfigM2Fields,
} from "@/lib/capture-config-form";

function RulePreviewDialog({
  siteId,
  rulesBeforeBaseEq,
  rulesBeforeStage2Eq,
  open,
  onOpenChange,
}: {
  siteId: number;
  rulesBeforeBaseEq: Rule[];
  rulesBeforeStage2Eq: Rule[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const [pages, setPages] = useState<SitePageListRow[]>([]);
  const [selectedPage, setSelectedPage] = useState<SitePageListRow | null>(null);
  const [previewResult, setPreviewResult] = useState<RulePreviewResult | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);

  useEffect(() => {
    if (!open) return;
    api.getSitePages(siteId, { page: 1, pageSize: 15, query }).then((data) => {
      setPages(data.rows || []);
    });
  }, [open, query, siteId]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setSelectedPage(null);
      setPreviewResult(null);
    }
  }, [open]);

  const selectPage = async (page: SitePageListRow) => {
    setSelectedPage(page);
    setIsPreviewing(true);
    setPreviewResult(null);
    try {
      const labels = labelsArrayToRecord(page.labels);
      const result = await api.previewRules(siteId, {
        url: page.url,
        labels: Object.keys(labels).length > 0 ? labels : undefined,
        rulesBeforeBaseEq,
        rulesBeforeStage2Eq,
      });
      setPreviewResult(result);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '试运行失败。');
    } finally {
      setIsPreviewing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl w-full overflow-hidden">
        <DialogHeader>
          <DialogTitle>规则试运行</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 w-full min-w-0">
          <p className="text-sm text-muted-foreground">选择一个页面，使用当前表单规则（未保存也可）预览判定结果。</p>
          <div className="relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="搜索页面 URL 或标题..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="max-h-52 overflow-y-auto rounded-md border divide-y">
            {pages.map((page) => (
              <button
                key={page.sitePageId}
                type="button"
                className={`w-full min-w-0 text-left px-3 py-2.5 text-sm hover:bg-muted/50 transition-colors ${selectedPage?.sitePageId === page.sitePageId ? 'bg-muted' : ''}`}
                onClick={() => selectPage(page)}
              >
                <div className="font-medium truncate">{page.title}</div>
                <div className="text-xs text-muted-foreground truncate">{page.url}</div>
                {page.labels.length > 0 && (
                  <div className="text-xs text-muted-foreground/70 truncate mt-0.5">{page.labels.join(', ')}</div>
                )}
              </button>
            ))}
            {pages.length === 0 && (
              <div className="py-8 text-center text-sm text-muted-foreground">暂无页面。</div>
            )}
          </div>
          {selectedPage && (
            <div className="space-y-2 pt-1">
              {isPreviewing && <div className="text-sm text-muted-foreground">计算中...</div>}
              {previewResult && <RulePreviewResultGrid result={previewResult} />}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}


interface SiteConfigShape extends SiteConfigM2Fields {
  seedUrls: string[];
  sitemaps: string[];
  rulesBeforeBaseEq: Rule[];
  rulesBeforeStage2Eq: Rule[];
  runOptions: {
    seedMaxDepth: number;
    crawlMaxDepth: number;
    maxRequestRetries: number;
  };
  urlNormalization?: {
    stripQueryParams: string[];
    stripQueryParamPrefixes?: string[];
  };
}

type RulePoint = "rulesBeforeBaseEq" | "rulesBeforeStage2Eq";

type AssistantTarget =
  | { kind: "generic" }
  | { kind: "single"; point: RulePoint; index: number; rule: Rule };

function linesToArray(value: string): string[] {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function arrayToLines(value: string[]): string {
  return value.join("\n");
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function rulePointLabel(point: RulePoint): string {
  return point === "rulesBeforeBaseEq" ? "基础入队规则" : "深度爬取规则";
}

function ruleSummary(rule: Rule): string {
  const matchType = rule.matchType ?? "url";
  return `${matchType} / ${rule.listType}`;
}

function normalizeBaseRule(rule: Rule): Rule {
  return rule.listType === "whitelist" ? { ...rule, listType: "scopelist" } : rule;
}

function normalizeBaseRules(rules: Rule[]): Rule[] {
  return rules.map(normalizeBaseRule);
}

export function SiteConfig({ siteId }: { siteId: number }) {
  const [config, setConfig] = useState<SiteConfigShape | null>(null);
  const [jsonDraft, setJsonDraft] = useState("");
  const [seedUrlsText, setSeedUrlsText] = useState("");
  const [sitemapsText, setSitemapsText] = useState("");
  const [rulesBeforeBaseEq, setRulesBeforeBaseEq] = useState<Rule[]>([]);
  const [rulesBeforeStage2Eq, setRulesBeforeStage2Eq] = useState<Rule[]>([]);
  const [seedMaxDepth, setSeedMaxDepth] = useState("1");
  const [crawlMaxDepth, setCrawlMaxDepth] = useState("2");
  const [maxRequestRetries, setMaxRequestRetries] = useState("3");
  const [sites, setSites] = useState<Array<{ siteId: number; siteName: string }>>([]);
  const [sourceSiteId, setSourceSiteId] = useState("");
  const [projectId, setProjectId] = useState<number | null>(null);
  const [labelDefinitions, setLabelDefinitions] = useState<unknown>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantTarget, setAssistantTarget] = useState<AssistantTarget>({ kind: "generic" });
  const [previewOpen, setPreviewOpen] = useState(false);
  const [captureConfig, setCaptureConfig] = useState<CaptureConfigFormState>(() => captureConfigFromApi({}));

  const hydrate = (nextConfig: SiteConfigShape) => {
    setConfig(nextConfig);
    setJsonDraft(pretty(nextConfig));
    setSeedUrlsText(arrayToLines(nextConfig.seedUrls));
    setSitemapsText(arrayToLines(nextConfig.sitemaps));
    setRulesBeforeBaseEq(normalizeBaseRules((nextConfig.rulesBeforeBaseEq || []) as Rule[]));
    setRulesBeforeStage2Eq((nextConfig.rulesBeforeStage2Eq || []) as Rule[]);
    setSeedMaxDepth(String(nextConfig.runOptions.seedMaxDepth));
    setCrawlMaxDepth(String(nextConfig.runOptions.crawlMaxDepth));
    setMaxRequestRetries(String(nextConfig.runOptions.maxRequestRetries));
    setCaptureConfig(captureConfigFromApi(nextConfig));
  };

  const loadConfig = () => {
    api.getSiteConfig(siteId).then(hydrate);
    api.getSiteOverview(siteId).then((overview) => {
      setProjectId(overview.projectId);
      api.getProjectLabelDefinitions(overview.projectId).then((data) => {
        setLabelDefinitions(data.labelDefinitions ?? []);
      });
      api.getSites(overview.projectId).then((data) => {
        setSites((data.items || []).filter((site: { siteId: number }) => site.siteId !== siteId));
      });
    });
  };

  useEffect(() => {
    loadConfig();
  }, [siteId]);

  const buildFormConfig = (): SiteConfigShape => ({
    seedUrls: linesToArray(seedUrlsText),
    sitemaps: linesToArray(sitemapsText),
    rulesBeforeBaseEq: normalizeBaseRules(rulesBeforeBaseEq),
    rulesBeforeStage2Eq: rulesBeforeStage2Eq,
    runOptions: {
      seedMaxDepth: Number(seedMaxDepth),
      crawlMaxDepth: Number(crawlMaxDepth),
      maxRequestRetries: Number(maxRequestRetries),
    },
    urlNormalization: config?.urlNormalization,
    ...captureConfigToApi(captureConfig),
  });

  const saveConfig = async (nextConfig: SiteConfigShape) => {
    setIsSaving(true);
    try {
      const response = await api.updateSiteConfig(siteId, nextConfig);
      hydrate(response.config);
      toast.success("配置已保存，并通过后端校验。");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败。");
    } finally {
      setIsSaving(false);
    }
  };

  const saveForm = async () => {
    await saveConfig(buildFormConfig());
  };

  const saveJson = async () => {
    try {
      await saveConfig(JSON.parse(jsonDraft));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "JSON 格式不正确。");
    }
  };

  const cloneConfig = async () => {
    if (!sourceSiteId) return;
    setIsSaving(true);
    try {
      const response = await api.cloneSiteConfig(siteId, Number(sourceSiteId));
      hydrate(response.config);
      toast.success("已从目标站点克隆配置。");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "克隆失败。");
    } finally {
      setIsSaving(false);
    }
  };

  const openGenericAssistant = () => {
    setAssistantTarget({ kind: "generic" });
    setAssistantOpen(true);
  };

  const openSingleRuleAssistant = (point: RulePoint, rule: Rule, index: number) => {
    setAssistantTarget({ kind: "single", point, index, rule });
    setAssistantOpen(true);
  };

  const buildAssistantContext = (userInput: string, _history: LlmChatMessage[]) => {
    const labelsJsonl = labelDefinitionsToJsonl(labelDefinitions);

    if (assistantTarget.kind === "single") {
      return {
        labels_jsonl: labelsJsonl,
        rule_point: assistantTarget.point,
        rule_obj: JSON.stringify(assistantTarget.rule, null, 2),
        user_input: userInput,
      };
    }

    return {
      labels_jsonl: labelsJsonl,
      rulesBeforeBaseEq: JSON.stringify(rulesBeforeBaseEq, null, 2),
      rulesBeforeStage2Eq: JSON.stringify(rulesBeforeStage2Eq, null, 2),
      page_info: "",
      user_input: userInput,
    };
  };

  const applyAssistantResponse = async (content: string) => {
    if (assistantTarget.kind === "single") {
      const nextRule = parseAssistantJson<Rule>(content);
      if (assistantTarget.point === "rulesBeforeBaseEq") {
        const next = [...rulesBeforeBaseEq];
        next[assistantTarget.index] = normalizeBaseRule(nextRule);
        setRulesBeforeBaseEq(next);
      } else {
        const next = [...rulesBeforeStage2Eq];
        next[assistantTarget.index] = nextRule;
        setRulesBeforeStage2Eq(next);
      }
      toast.success("已应用到当前规则，保存表单配置后生效。");
      return;
    }

    const suggestions = parseAssistantJson<RuleAssistantSuggestion[]>(content);
    const result = applyRuleAssistantSuggestions({
      rulesBeforeBaseEq,
      rulesBeforeStage2Eq,
      suggestions,
    });
    setRulesBeforeBaseEq(normalizeBaseRules(result.rulesBeforeBaseEq));
    setRulesBeforeStage2Eq(result.rulesBeforeStage2Eq);
    toast.success(`已应用 ${result.appliedCount} 条建议，保存表单配置后生效。`);
  };

  const assistantContextSummary =
    assistantTarget.kind === "single"
      ? [
        { label: "入口", value: "规则卡片" },
        { label: "执行点", value: rulePointLabel(assistantTarget.point) },
        { label: "序号", value: String(assistantTarget.index + 1) },
        { label: "规则名", value: assistantTarget.rule.name },
        { label: "规则类型", value: ruleSummary(assistantTarget.rule) },
      ]
      : [
        { label: "入口", value: "规则配置表单" },
        { label: "范围", value: "全部规则" },
        { label: "基础规则", value: `${rulesBeforeBaseEq.length} 条` },
        { label: "深度规则", value: `${rulesBeforeStage2Eq.length} 条` },
      ];

  if (!config) {
    return <div className="animate-pulse p-8 text-muted-foreground">加载配置中...</div>;
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-baseline gap-2 space-y-0">
          <CardTitle>站点配置</CardTitle>
          <CardDescription>
            表单模式覆盖规则与 M2 抓取策略，JSON 模式保留完整逃生口；保存时统一走后端 SiteConfig 校验。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-[1fr_auto]">
            <select className="h-10 rounded-md border bg-background px-3 text-sm" value={sourceSiteId} onChange={(event) => setSourceSiteId(event.target.value)} disabled={!projectId || sites.length === 0}>
              <option value="">从同项目站点克隆配置</option>
              {sites.map((site) => <option key={site.siteId} value={site.siteId}>{site.siteName}</option>)}
            </select>
            <Button variant="outline" className="gap-2" disabled={!sourceSiteId || isSaving} onClick={cloneConfig}>
              <Copy className="w-4 h-4" />
              克隆配置
            </Button>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="form">
        <TabsList>
          <TabsTrigger value="form">表单模式</TabsTrigger>
          <TabsTrigger value="json">JSON 高级模式</TabsTrigger>
        </TabsList>

        <TabsContent value="form" className="space-y-6">
          <div className="flex justify-end">
            <Button type="button" variant="outline" className="gap-2" onClick={openGenericAssistant}>
              <WandSparkles className="h-4 w-4" />
              规则编辑助手
            </Button>
          </div>

          <Card>
            <CardHeader className="flex flex-row items-baseline gap-2 space-y-0">
              <CardTitle>入口与深度</CardTitle>
              <CardDescription>每行一个 URL；seed 只用于摸底，crawl 用于正式递归深度。</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 lg:grid-cols-[1fr_1fr_8rem_8rem_9rem]">
              <div className="space-y-2">
                <Label>Seed URLs</Label>
                <textarea className="h-[48px] w-full rounded-md border bg-background px-3 py-1 text-sm resize-none" value={seedUrlsText} onChange={(event) => setSeedUrlsText(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Sitemaps</Label>
                <textarea className="h-[48px] w-full rounded-md border bg-background px-3 py-1 text-sm resize-none" value={sitemapsText} onChange={(event) => setSitemapsText(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Seed Max Depth</Label>
                <Input type="number" min="0" value={seedMaxDepth} onChange={(event) => setSeedMaxDepth(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Crawl Max Depth</Label>
                <Input type="number" min="0" value={crawlMaxDepth} onChange={(event) => setCrawlMaxDepth(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Max Retries</Label>
                <Input type="number" min="0" value={maxRequestRetries} onChange={(event) => setMaxRequestRetries(event.target.value)} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <div className="flex items-baseline gap-2">
                <CardTitle>基础入队规则</CardTitle>
                <CardDescription>用于过滤不符合条件的 URL，支持黑名单和范围限定。仅支持 URL 匹配。</CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRulesBeforeBaseEq([...rulesBeforeBaseEq, createDefaultRule("scopelist")])}
                className="gap-1"
              >
                <Plus className="w-4 h-4" /> 添加规则
              </Button>
            </CardHeader>
            <CardContent>
              <RuleListEditor
                rules={rulesBeforeBaseEq}
                onChange={setRulesBeforeBaseEq}
                allowLabelMatch={false}
                showArtifacts={false}
                allowedListTypes={["scopelist", "blacklist"]}
                hideAddButton
                onAssistRule={(rule, index) => openSingleRuleAssistant("rulesBeforeBaseEq", rule, index)}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <div className="flex items-baseline gap-2">
                <CardTitle>深度爬取规则</CardTitle>
                <CardDescription>用于指定是否爬取Markdown/截图/结构化数据，支持 URL 匹配和 HTML 标签匹配。</CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRulesBeforeStage2Eq([...rulesBeforeStage2Eq, createDefaultRule()])}
                className="gap-1"
              >
                <Plus className="w-4 h-4" /> 添加规则
              </Button>
            </CardHeader>
            <CardContent>
              <RuleListEditor
                rules={rulesBeforeStage2Eq}
                onChange={setRulesBeforeStage2Eq}
                allowLabelMatch={true}
                hideAddButton
                onAssistRule={(rule, index) => openSingleRuleAssistant("rulesBeforeStage2Eq", rule, index)}
              />
            </CardContent>
          </Card>

          <CaptureConfigEditor value={captureConfig} onChange={setCaptureConfig} />

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" className="gap-2" onClick={() => setPreviewOpen(true)}>
              <Play className="w-4 h-4" />
              试运行规则
            </Button>
            <Button className="gap-2" onClick={saveForm} disabled={isSaving}>
              <Save className="w-4 h-4" />
              保存表单配置
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="json">
          <Card>
            <CardHeader className="flex flex-row items-baseline gap-2 space-y-0">
              <CardTitle>完整 SiteConfig JSON</CardTitle>
              <CardDescription>适合粘贴外部配置、批量编辑规则或精确调整字段。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <textarea className="h-[560px] w-full rounded-md border bg-muted/20 p-4 font-mono text-xs" value={jsonDraft} onChange={(event) => setJsonDraft(event.target.value)} />
              <div className="flex justify-end">
                <Button className="gap-2" onClick={saveJson} disabled={isSaving}>
                  <Save className="w-4 h-4" />
                  保存 JSON 配置
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <LLMChatPanel
        open={assistantOpen}
        onOpenChange={setAssistantOpen}
        promptName={assistantTarget.kind === "single" ? "rule-assistant-singlerule" : "rule-assistant-generic"}
        title="规则编辑助手"
        applyLabel={assistantTarget.kind === "single" ? "应用到规则" : "应用到表单"}
        contextSummary={assistantContextSummary}
        resetKey={
          assistantTarget.kind === "single"
            ? `${assistantTarget.point}:${assistantTarget.index}:${assistantTarget.rule.name}`
            : "generic"
        }
        buildContext={buildAssistantContext}
        onApply={applyAssistantResponse}
      />

      <RulePreviewDialog
        siteId={siteId}
        rulesBeforeBaseEq={rulesBeforeBaseEq}
        rulesBeforeStage2Eq={rulesBeforeStage2Eq}
        open={previewOpen}
        onOpenChange={setPreviewOpen}
      />
    </div>
  );
}
