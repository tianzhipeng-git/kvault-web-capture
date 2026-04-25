import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Copy, Save, Plus, WandSparkles } from "lucide-react";
import { toast } from "sonner";
import { LLMChatPanel } from "@/components/LLMChatPanel";
import type { LlmChatMessage } from "@/lib/api";
import {
  applyRuleAssistantSuggestions,
  parseAssistantJson,
  tagDefinitionsToJsonl,
  type RuleAssistantSuggestion,
} from "@/lib/rule-assistant";
import { RuleListEditor, type Rule, createDefaultRule } from "./RuleEditor";

interface SiteConfigShape {
  seedUrls: string[];
  sitemaps: string[];
  rulesBeforeBaseEq: Rule[];
  rulesBeforeStage2Eq: Rule[];
  runOptions: {
    seedMaxDepth: number;
    crawlMaxDepth: number;
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

export function SiteConfig({ siteId }: { siteId: number }) {
  const [config, setConfig] = useState<SiteConfigShape | null>(null);
  const [jsonDraft, setJsonDraft] = useState("");
  const [seedUrlsText, setSeedUrlsText] = useState("");
  const [sitemapsText, setSitemapsText] = useState("");
  const [rulesBeforeBaseEq, setRulesBeforeBaseEq] = useState<Rule[]>([]);
  const [rulesBeforeStage2Eq, setRulesBeforeStage2Eq] = useState<Rule[]>([]);
  const [seedMaxDepth, setSeedMaxDepth] = useState("1");
  const [crawlMaxDepth, setCrawlMaxDepth] = useState("2");
  const [sites, setSites] = useState<Array<{ siteId: number; siteName: string }>>([]);
  const [sourceSiteId, setSourceSiteId] = useState("");
  const [projectId, setProjectId] = useState<number | null>(null);
  const [tagDefinitions, setTagDefinitions] = useState<unknown>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantTarget, setAssistantTarget] = useState<AssistantTarget>({ kind: "generic" });

  const hydrate = (nextConfig: SiteConfigShape) => {
    setConfig(nextConfig);
    setJsonDraft(pretty(nextConfig));
    setSeedUrlsText(arrayToLines(nextConfig.seedUrls));
    setSitemapsText(arrayToLines(nextConfig.sitemaps));
    setRulesBeforeBaseEq((nextConfig.rulesBeforeBaseEq || []) as Rule[]);
    setRulesBeforeStage2Eq((nextConfig.rulesBeforeStage2Eq || []) as Rule[]);
    setSeedMaxDepth(String(nextConfig.runOptions.seedMaxDepth));
    setCrawlMaxDepth(String(nextConfig.runOptions.crawlMaxDepth));
  };

  const loadConfig = () => {
    api.getSiteConfig(siteId).then(hydrate);
    api.getSiteOverview(siteId).then((overview) => {
      setProjectId(overview.projectId);
      api.getProjectTagDefinitions(overview.projectId).then((data) => {
        setTagDefinitions(data.tagDefinitions ?? []);
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
    rulesBeforeBaseEq: rulesBeforeBaseEq,
    rulesBeforeStage2Eq: rulesBeforeStage2Eq,
    runOptions: {
      seedMaxDepth: Number(seedMaxDepth),
      crawlMaxDepth: Number(crawlMaxDepth),
    },
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
    const tagsJsonl = tagDefinitionsToJsonl(tagDefinitions);

    if (assistantTarget.kind === "single") {
      return {
        tags_jsonl: tagsJsonl,
        rule_point: assistantTarget.point,
        rule_obj: JSON.stringify(assistantTarget.rule, null, 2),
        user_input: userInput,
      };
    }

    return {
      tags_jsonl: tagsJsonl,
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
        next[assistantTarget.index] = nextRule;
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
    setRulesBeforeBaseEq(result.rulesBeforeBaseEq);
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
          <CardTitle>规则配置</CardTitle>
          <CardDescription>
            表单模式覆盖常用配置，JSON 模式保留完整逃生口；保存时统一走后端 SiteConfig 校验。
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
            <CardContent className="grid gap-4 lg:grid-cols-2">
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
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <div className="flex items-baseline gap-2">
                <CardTitle>基础入队规则</CardTitle>
                <CardDescription>用于过滤不符合条件的 URL，支持黑白名单和范围限定。仅支持 URL 匹配。</CardDescription>
              </div>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={() => setRulesBeforeBaseEq([...rulesBeforeBaseEq, createDefaultRule()])}
                className="gap-1"
              >
                <Plus className="w-4 h-4" /> 添加规则
              </Button>
            </CardHeader>
            <CardContent>
              <RuleListEditor 
                rules={rulesBeforeBaseEq} 
                onChange={setRulesBeforeBaseEq} 
                allowTagMatch={false} 
                showArtifacts={false} 
                hideAddButton 
                onAssistRule={(rule, index) => openSingleRuleAssistant("rulesBeforeBaseEq", rule, index)}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <div className="flex items-baseline gap-2">
                <CardTitle>深度爬取规则</CardTitle>
                <CardDescription>用于指定如何截取正文，支持 URL 匹配和 HTML 标签匹配。</CardDescription>
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
                allowTagMatch={true} 
                hideAddButton 
                onAssistRule={(rule, index) => openSingleRuleAssistant("rulesBeforeStage2Eq", rule, index)}
              />
            </CardContent>
          </Card>

          <div className="flex justify-end">
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
    </div>
  );
}
