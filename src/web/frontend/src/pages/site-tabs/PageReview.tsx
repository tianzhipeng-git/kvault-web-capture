import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ProcessingState, ProjectExportArtifact, SitePageDetail, SitePageListRow } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { RunLogs } from "@/components/RunLogs";
import { LLMChatPanel } from "@/components/LLMChatPanel";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { LlmChatMessage } from "@/lib/api";
import {
  applyRuleAssistantSuggestions,
  parseAssistantJson,
  labelDefinitionsToJsonl,
  type RuleAssistantSuggestion,
} from "@/lib/rule-assistant";
import type { Rule } from "./RuleEditor";
import { CheckCircle2, ChevronDown, CircleDashed, Download, Filter, History, Image, Loader2, Play, RotateCcw, ScrollText, Search, WandSparkles, XCircle } from "lucide-react";
import { RulePreviewResultGrid, labelsArrayToRecord, type RulePreviewResult } from "@/components/RulePreview";

const statusOptions = [
  { value: "", label: "全部状态" },
  { value: "stage2_pending", label: "待确认" },
  { value: "stage2_captured", label: "已完成采集" },
  { value: "base_captured", label: "已完成基础信息" },
  { value: "url_rule_denied", label: "不采集" },
  { value: "stage2_skipped", label: "无需深入采集" },
  { value: "discovered_only", label: "仅发现" },
];

const pendingReasonOptions = [
  { value: "", label: "全部待确认原因" },
  { value: "seed_run", label: "初步摸底" },
  { value: "rule_unmatched", label: "规则未匹配" },
  { value: "classifier_failed", label: "分类失败" },
];

const minPageSize = 1;
const maxPageSize = 500;
const exportArtifactOptions: Array<{ value: ProjectExportArtifact; label: string }> = [
  { value: "base", label: "Base 文本" },
  { value: "markdown", label: "Markdown" },
  { value: "screenshot", label: "截图" },
  { value: "structured", label: "结构化 JSON" },
];
type UpdatePolicy = "skip_existing" | "force_recrawl_all" | "stale_after_duration";

const updatePolicyOptions: Array<{ value: UpdatePolicy; label: string }> = [
  { value: "skip_existing", label: "跳过已有成功结果" },
  { value: "force_recrawl_all", label: "强制重新采集" },
  { value: "stale_after_duration", label: "超过时间后更新" },
];

function statusFilterLabel(values: string[]): string {
  if (values.length === 0) return "全部状态";
  if (values.length === 1) {
    return statusOptions.find((option) => option.value === values[0])?.label ?? "已选 1 个状态";
  }
  return `已选 ${values.length} 个状态`;
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "-";
}

function statusVariant(page: SitePageListRow): "default" | "secondary" | "destructive" | "outline" {
  if (page.businessStatus === "不采集") return "destructive";
  if (page.needsReview) return "secondary";
  if (page.businessStatus === "已完成采集") return "default";
  return "outline";
}

function parsePageIdInput(value: string): number[] {
  const tokens = value
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const pageIds = tokens.map((token) => Number(token));

  if (pageIds.length === 0) {
    throw new Error("请先输入 page ID。");
  }

  if (pageIds.some((pageId) => !Number.isInteger(pageId) || pageId <= 0)) {
    throw new Error("page ID 列表中包含无效 ID。");
  }

  return [...new Set(pageIds)];
}

function parseUrlInput(value: string): string[] {
  const urls = value
    .split(/\r?\n/)
    .map((url) => url.trim())
    .filter(Boolean);

  if (urls.length === 0) {
    throw new Error("请先输入要重跑的 URL。");
  }

  return [...new Set(urls)];
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

type PreviewKind = "base" | "markdown" | "screenshot" | "structured";
type PreviewMode = "text" | "markdown";

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

function ProcessingCard({
  state,
  active,
  onSelect,
}: {
  state: ProcessingState;
  active: boolean;
  onSelect: () => void;
}) {
  const Icon = state.succeeded ? CheckCircle2 : state.shouldRun ? XCircle : CircleDashed;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`rounded-lg border bg-muted/20 p-4 space-y-3 text-left transition-colors hover:bg-muted/40 min-w-0 ${active ? "border-primary ring-2 ring-primary/20" : ""}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 font-semibold">
          <Icon className={state.succeeded ? "w-4 h-4 text-green-600" : state.shouldRun ? "w-4 h-4 text-orange-600" : "w-4 h-4 text-muted-foreground"} />
          <span className="truncate">{state.label}</span>
        </div>
        <Badge className="shrink-0" variant={state.succeeded ? "default" : state.shouldRun ? "secondary" : "outline"}>
          {state.shouldRun ? "应该运行" : "不要求运行"}
        </Badge>
      </div>
      <div className="grid gap-2 text-sm text-muted-foreground">
        <div>结果：<span className="text-foreground">{state.statusLabel}</span></div>
        <div>原因：<span className="text-foreground">{state.reason}</span></div>
        <div>Tool：<span className="text-foreground">{state.toolName ?? "-"}</span></div>
        <div>Run：<span className="text-foreground">{state.runId ?? "-"}</span></div>
        <div>时间：<span className="text-foreground">{formatDate(state.handledAt)}</span></div>
        {state.outputPath && <div className="break-all">输出：<span className="text-foreground">{state.outputPath}</span></div>}
      </div>
    </button>
  );
}

const markdownComponents: Components = {
  h1: ({ children }) => <h1 className="mt-5 first:mt-0 text-xl font-semibold leading-7">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-5 first:mt-0 text-lg font-semibold leading-7">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-4 first:mt-0 text-base font-semibold leading-6">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-4 first:mt-0 text-sm font-semibold leading-6">{children}</h4>,
  p: ({ children }) => <p className="my-3 text-sm leading-6">{children}</p>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-6 text-sm leading-6">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-6 text-sm leading-6">{children}</ol>,
  li: ({ children }) => <li className="pl-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-4 border-l-4 border-border pl-4 text-sm text-muted-foreground">{children}</blockquote>
  ),
  code: ({ className, children }) => (
    <code className={className ? className : "rounded bg-muted px-1.5 py-0.5 text-xs"}>{children}</code>
  ),
  pre: ({ children }) => <pre className="my-4 overflow-auto rounded-md bg-muted p-3 text-xs leading-5">{children}</pre>,
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-md border">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b bg-muted px-3 py-2 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border-t px-3 py-2 align-top">{children}</td>,
  hr: () => <hr className="my-5 border-border" />,
};

function MarkdownPreview({ content }: { content: string }) {
  if (!content.trim()) {
    return <div className="text-sm text-muted-foreground">暂无内容。</div>;
  }

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {content}
    </ReactMarkdown>
  );
}

function PreviewPanel({
  detail,
  activePreview,
  previewMode,
  onPreviewModeChange,
}: {
  detail: SitePageDetail;
  activePreview: PreviewKind;
  previewMode: PreviewMode;
  onPreviewModeChange: (mode: PreviewMode) => void;
}) {
  const preview =
    activePreview === "base"
      ? detail.latestPreviews.base
      : activePreview === "markdown"
        ? detail.latestPreviews.markdown
        : activePreview === "screenshot"
          ? detail.latestPreviews.screenshot
          : detail.latestPreviews.structured;
  const title =
    activePreview === "base"
      ? "基础爬取预览"
      : activePreview === "markdown"
        ? "Markdown 预览"
        : activePreview === "screenshot"
          ? "Screenshot 预览"
          : "结构化 JSON 预览";
  const textContent = "content" in preview ? preview.content : null;

  return (
    <div className="w-full min-w-0 overflow-hidden rounded-xl border p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{title}</div>
          <div className="text-xs text-muted-foreground truncate">{preview.outputPath || "暂无输出文件"}</div>
        </div>
        {activePreview !== "screenshot" && activePreview !== "structured" && (
          <div className="flex rounded-md border p-1 shrink-0">
            <Button size="sm" variant={previewMode === "text" ? "default" : "ghost"} onClick={() => onPreviewModeChange("text")}>文本</Button>
            <Button size="sm" variant={previewMode === "markdown" ? "default" : "ghost"} onClick={() => onPreviewModeChange("markdown")}>Markdown</Button>
          </div>
        )}
      </div>

      {activePreview === "screenshot" ? (
        detail.latestPreviews.screenshot.artifactRunId ? (
          <div className="h-[520px] max-w-full overflow-auto rounded-lg bg-muted/30 p-3">
            <img
              className="max-h-full w-full object-contain"
              src={`${import.meta.env.BASE_URL.replace(/\/$/, '')}/api/sites/${detail.siteId}/artifacts/${detail.latestPreviews.screenshot.artifactRunId}/file`}
              alt="Screenshot preview"
            />
          </div>
        ) : (
          <div className="flex min-h-40 items-center justify-center rounded-lg bg-muted/30 text-sm text-muted-foreground">
            <Image className="mr-2 h-4 w-4" />
            暂无截图文件。
          </div>
        )
      ) : activePreview === "structured" ? (
        <div className="h-[520px] overflow-auto rounded-lg bg-muted p-3" style={{ maxWidth: '1400px' }}>
          <pre className="whitespace-pre-wrap break-words text-xs m-0 p-0">{textContent || "暂无结构化内容。"}</pre>
        </div>
      ) : previewMode === "markdown" ? (
        <div className="h-[520px] max-w-full overflow-auto rounded-lg bg-background p-3">
          <MarkdownPreview content={textContent || ""} />
        </div>
      ) : (
        <div className="h-[520px] overflow-auto rounded-lg bg-muted p-3" style={{ maxWidth: '1400px' }}>
          <pre className="whitespace-pre text-xs m-0 p-0">{textContent || "暂无文件内容。"}</pre>
        </div>
      )}
    </div>
  );
}

function PageDetailDialog({
  detail,
  onClose,
}: {
  detail: SitePageDetail | null;
  onClose: () => void;
}) {
  const [activePreview, setActivePreview] = useState<PreviewKind>("base");
  const [previewMode, setPreviewMode] = useState<PreviewMode>("text");
  const [expandedLogRunId, setExpandedLogRunId] = useState<number | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [siteConfig, setSiteConfig] = useState<SiteConfigShape | null>(null);
  const [labelDefinitions, setLabelDefinitions] = useState<unknown>([]);
  const [rulePreviewResult, setRulePreviewResult] = useState<RulePreviewResult | null>(null);
  const [isPreviewingRules, setIsPreviewingRules] = useState(false);

  useEffect(() => {
    setActivePreview("base");
    setPreviewMode("text");
    setExpandedLogRunId(null);
    setAssistantOpen(false);
    setRulePreviewResult(null);
    setIsPreviewingRules(false);
  }, [detail?.sitePageId]);

  useEffect(() => {
    if (!detail) {
      setSiteConfig(null);
      setLabelDefinitions([]);
      return;
    }

    api.getSiteConfig(detail.siteId).then((config) => setSiteConfig(config as SiteConfigShape));
    api.getSiteOverview(detail.siteId).then((overview) => {
      api.getProjectLabelDefinitions(overview.projectId).then((data) => {
        setLabelDefinitions(data.labelDefinitions ?? []);
      });
    });
  }, [detail]);

  const buildPageInfo = (pageDetail: SitePageDetail): string => [
    `url: ${pageDetail.url}`,
    `title: ${pageDetail.title}`,
    `labels: ${pageDetail.latestLabels.length > 0 ? pageDetail.latestLabels.join(", ") : "无"}`,
    `根据当前规则是否应该base抓取: ${pageDetail.latestBase.shouldRun ? "是" : "否"}`,
    `根据当前规则是否应该Markdown抓取: ${pageDetail.latestMarkdown.shouldRun ? "是" : "否"}`,
    `根据当前规则是否应该截图: ${pageDetail.latestScreenshot.shouldRun ? "是" : "否"}`,
    `根据当前规则是否应该结构化抓取: ${pageDetail.latestStructured.shouldRun ? "是" : "否"}`,
    `当前页面状态: ${pageDetail.businessStatus}`,
    `当前规则判定: ${pageDetail.latestDecision ?? "无"}`,
    `待确认原因: ${pageDetail.latestPendingReasonLabel ?? "无"}`,
  ].join("\n");

  const buildAssistantContext = (userInput: string, _history: LlmChatMessage[]) => ({
    labels_jsonl: labelDefinitionsToJsonl(labelDefinitions),
    rulesBeforeBaseEq: JSON.stringify(siteConfig?.rulesBeforeBaseEq ?? [], null, 2),
    rulesBeforeStage2Eq: JSON.stringify(siteConfig?.rulesBeforeStage2Eq ?? [], null, 2),
    page_info: detail ? buildPageInfo(detail) : "",
    user_input: userInput,
  });

  const applyAssistantResponse = async (content: string) => {
    if (!detail || !siteConfig) {
      throw new Error("站点配置还没有加载完成。");
    }

    const suggestions = parseAssistantJson<RuleAssistantSuggestion[]>(content);
    const result = applyRuleAssistantSuggestions({
      rulesBeforeBaseEq: siteConfig.rulesBeforeBaseEq,
      rulesBeforeStage2Eq: siteConfig.rulesBeforeStage2Eq,
      suggestions,
    });
    const nextConfig = {
      ...siteConfig,
      rulesBeforeBaseEq: result.rulesBeforeBaseEq,
      rulesBeforeStage2Eq: result.rulesBeforeStage2Eq,
    };
    const response = await api.updateSiteConfig(detail.siteId, nextConfig);
    setSiteConfig(response.config as SiteConfigShape);
    toast.success(`已更新配置，应用了 ${result.appliedCount} 条建议。`);
  };

  const assistantContextSummary = detail
    ? [
        { label: "入口", value: "页面详情弹窗" },
        { label: "页面", value: detail.title },
        { label: "URL", value: detail.url },
        { label: "状态", value: detail.businessStatus },
        { label: "Base", value: detail.latestBase.shouldRun ? "应该抓取" : "不要求抓取" },
        { label: "Markdown", value: detail.latestMarkdown.shouldRun ? "应该抓取" : "不要求抓取" },
        { label: "截图", value: detail.latestScreenshot.shouldRun ? "应该抓取" : "不要求抓取" },
        { label: "结构化", value: detail.latestStructured.shouldRun ? "应该抓取" : "不要求抓取" },
      ]
    : [];

  const runRulePreview = async () => {
    if (!detail) return;
    setIsPreviewingRules(true);
    setRulePreviewResult(null);
    try {
      const labels = labelsArrayToRecord(detail.latestLabels);
      const result = await api.previewRules(detail.siteId, {
        url: detail.url,
        labels: Object.keys(labels).length > 0 ? labels : undefined,
      });
      setRulePreviewResult(result);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '试运行失败。');
    } finally {
      setIsPreviewingRules(false);
    }
  };

  return (
    <Dialog open={!!detail} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[92vw] w-[92vw] max-h-[90vh] overflow-y-auto overflow-x-hidden grid-cols-1">
        <DialogHeader className="pr-10">
          <DialogTitle>页面详情</DialogTitle>
        </DialogHeader>
        {detail && (
          <div className="space-y-6 min-w-0 overflow-hidden">
            <div className="rounded-xl border bg-muted/20 p-4 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-lg font-semibold">{detail.title}</div>
                  <a href={detail.url} target="_blank" rel="noopener noreferrer" className="text-sm text-muted-foreground break-all hover:underline">{detail.url}</a>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button type="button" variant="outline" className="gap-2" onClick={runRulePreview} disabled={isPreviewingRules}>
                    <Play className="h-4 w-4" />
                    {isPreviewingRules ? '计算中...' : '试运行规则'}
                  </Button>
                  <Button type="button" variant="outline" className="gap-2" onClick={() => setAssistantOpen(true)}>
                    <WandSparkles className="h-4 w-4" />
                    规则编辑助手
                  </Button>
                </div>
              </div>
              {rulePreviewResult && (
                <div className="pt-1">
                  <RulePreviewResultGrid result={rulePreviewResult} />
                </div>
              )}
              <div className="grid gap-3 md:grid-cols-3 text-sm">
                <div>业务状态：<Badge variant="outline">{detail.businessStatus}</Badge></div>
                <div>发现来源：{detail.discoverySource}</div>
                <div>发现时间：{formatDate(detail.firstDiscoveredAt)}</div>
              </div>
              {detail.latestLabels.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {detail.latestLabels.map((label) => <Badge key={label} variant="secondary">{label}</Badge>)}
                </div>
              )}
            </div>

            <div className="grid gap-4 md:grid-cols-4">
              <ProcessingCard state={detail.latestBase} active={activePreview === "base"} onSelect={() => setActivePreview("base")} />
              <ProcessingCard state={detail.latestMarkdown} active={activePreview === "markdown"} onSelect={() => setActivePreview("markdown")} />
              <ProcessingCard state={detail.latestScreenshot} active={activePreview === "screenshot"} onSelect={() => setActivePreview("screenshot")} />
              <ProcessingCard state={detail.latestStructured} active={activePreview === "structured"} onSelect={() => setActivePreview("structured")} />
            </div>

            {detail.latestPageRun && (
              <PreviewPanel
                detail={detail}
                activePreview={activePreview}
                previewMode={previewMode}
                onPreviewModeChange={setPreviewMode}
              />
            )}

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><History className="w-4 h-4" /> 历史运行记录</CardTitle>
                <CardDescription>按 crawl_runs 聚合该页面的 page_runs 和 artifact_runs。</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {detail.runHistory.map((run) => (
                  <div key={run.runId} className="rounded-lg border px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="font-semibold text-sm">Run #{run.runId} · {run.runTypeLabel}</div>
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-sm text-muted-foreground">{run.statusLabel} · {formatDate(run.startedAt)}</div>
                        <Button
                          type="button"
                          size="sm"
                          variant={expandedLogRunId === run.runId ? "secondary" : "outline"}
                          className="h-7 gap-1.5 px-2 text-xs"
                          onClick={() => setExpandedLogRunId((current) => (current === run.runId ? null : run.runId))}
                        >
                          <ScrollText className="h-3.5 w-3.5" />
                          {expandedLogRunId === run.runId ? "收起日志" : "查看日志"}
                        </Button>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs">
                      {run.pageRuns.map((pageRun) => (
                        <Badge key={pageRun.pageRunId} variant="outline">
                          PageRun #{pageRun.pageRunId} · base {pageRun.baseStatus} · {pageRun.decisionOutcome}
                        </Badge>
                      ))}
                      {run.artifactRuns.map((artifact) => (
                        <Badge key={artifact.artifactRunId} variant={artifact.status === "failed" ? "destructive" : "secondary"}>
                          {artifact.artifactType} · {artifact.status}
                        </Badge>
                      ))}
                    </div>
                    {expandedLogRunId === run.runId && (
                      <div className="mt-3 max-h-[360px] overflow-y-auto rounded-md border bg-background p-2 font-mono text-xs">
                        <RunLogs runId={run.runId} sitePageId={detail.sitePageId} includeRunError={false} inline />
                      </div>
                    )}
                  </div>
                ))}
                {detail.runHistory.length === 0 && (
                  <div className="py-8 text-center text-sm text-muted-foreground">还没有运行记录。</div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
        <LLMChatPanel
          open={assistantOpen}
          onOpenChange={setAssistantOpen}
          promptName="rule-assistant-generic"
          title="规则编辑助手"
          applyLabel="更新配置"
          contextSummary={assistantContextSummary}
          resetKey={detail?.sitePageId ?? "page-detail"}
          buildContext={buildAssistantContext}
          onApply={applyAssistantResponse}
        />
      </DialogContent>
    </Dialog>
  );
}

export function PageReview({
  siteId,
  crawlRunId,
  title = "页面清单",
  description = "以 site_pages 为基本单位查看站点页面。",
  onRecrawlStarted,
  enableExport = false,
}: {
  siteId: number;
  crawlRunId?: number;
  title?: string;
  description?: string;
  onRecrawlStarted?: () => void;
  enableExport?: boolean;
}) {
  const [pages, setPages] = useState<SitePageListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [pageSizeInput, setPageSizeInput] = useState("20");
  const [query, setQuery] = useState("");
  const [statuses, setStatuses] = useState<string[]>([]);
  const [label, setLabel] = useState("");
  const [pendingReason, setPendingReason] = useState("");
  const [jumpPage, setJumpPage] = useState("1");
  const [isLoading, setIsLoading] = useState(false);
  const [detail, setDetail] = useState<SitePageDetail | null>(null);
  const [selectedPages, setSelectedPages] = useState<Map<number, { url: string; title: string }>>(new Map());
  const [viewSelectedOpen, setViewSelectedOpen] = useState(false);
  const [confirmRecrawlOpen, setConfirmRecrawlOpen] = useState(false);
  const [recrawlUpdatePolicy, setRecrawlUpdatePolicy] = useState<UpdatePolicy>("force_recrawl_all");
  const [recrawlStaleAfterDays, setRecrawlStaleAfterDays] = useState("");
  const [recrawlUrlsInput, setRecrawlUrlsInput] = useState("");
  const [isSubmittingRecrawl, setIsSubmittingRecrawl] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [pageIdExportOpen, setPageIdExportOpen] = useState(false);
  const [pageIdExportInput, setPageIdExportInput] = useState("");
  const [isExportingPageIds, setIsExportingPageIds] = useState(false);
  const [selectedPageIdExportArtifacts, setSelectedPageIdExportArtifacts] = useState<Set<ProjectExportArtifact>>(
    new Set(["base", "markdown", "screenshot", "structured"]),
  );

  useEffect(() => {
    setIsLoading(true);
    api.getSitePages(siteId, {
      page,
      pageSize,
      query,
      status: statuses,
      label,
      pendingReason,
      crawlRunId,
    })
      .then((data) => {
        setPages(data.rows || []);
        setTotal(data.total || 0);
      })
      .finally(() => setIsLoading(false));
  }, [crawlRunId, page, pageSize, pendingReason, query, siteId, statuses, label]);

  const openDetail = async (sitePageId: number) => {
    const nextDetail = await api.getSitePageDetail(siteId, sitePageId);
    setDetail(nextDetail);
  };

  const togglePage = (item: SitePageListRow) => {
    setSelectedPages((prev) => {
      const next = new Map(prev);
      if (next.has(item.sitePageId)) {
        next.delete(item.sitePageId);
      } else {
        next.set(item.sitePageId, { url: item.url, title: item.title });
      }
      return next;
    });
  };

  const allCurrentSelected = pages.length > 0 && pages.every((p) => selectedPages.has(p.sitePageId));

  const toggleAll = () => {
    setSelectedPages((prev) => {
      const next = new Map(prev);
      if (allCurrentSelected) {
        for (const p of pages) next.delete(p.sitePageId);
      } else {
        for (const p of pages) next.set(p.sitePageId, { url: p.url, title: p.title });
      }
      return next;
    });
  };

  const openRecrawlDialog = () => {
    setRecrawlUrlsInput([...selectedPages.values()].map((p) => p.url).join("\n"));
    setConfirmRecrawlOpen(true);
  };

  const submitRecrawl = async () => {
    let initialUrls: string[];
    try {
      initialUrls = parseUrlInput(recrawlUrlsInput);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "URL 列表无效。");
      return;
    }

    const staleAfterDays = recrawlStaleAfterDays ? Number(recrawlStaleAfterDays) : null;
    const staleAfterMs = recrawlUpdatePolicy === "stale_after_duration" && staleAfterDays !== null
      ? staleAfterDays * 24 * 60 * 60 * 1000
      : null;

    if (
      recrawlUpdatePolicy === "stale_after_duration"
      && (staleAfterDays === null || Number.isNaN(staleAfterDays) || staleAfterDays <= 0)
    ) {
      toast.error("请选择过期策略时需要填写有效的过期天数。");
      return;
    }

    const count = initialUrls.length;
    setIsSubmittingRecrawl(true);
    try {
      await api.startCrawlRun(siteId, {
        updatePolicy: recrawlUpdatePolicy,
        targetSuccessCount: null,
        staleAfterMs,
        initialUrls,
        crawlMaxDepthOverride: 0,
      });
      setConfirmRecrawlOpen(false);
      setSelectedPages(new Map());
      toast.success(`已提交 ${count} 个页面的重跑任务。`);
      onRecrawlStarted?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '提交失败。');
    } finally {
      setIsSubmittingRecrawl(false);
    }
  };

  const exportPages = async () => {
    setIsExporting(true);
    try {
      const { blob, filename } = await api.exportSitePages(siteId, {
        query,
        status: statuses,
        label,
        pendingReason,
        crawlRunId,
      });
      downloadBlob(blob, filename);
      toast.success('页面清单已导出。');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出失败。');
    } finally {
      setIsExporting(false);
    }
  };

  const togglePageIdExportArtifact = (artifact: ProjectExportArtifact, checked: boolean) => {
    setSelectedPageIdExportArtifacts((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(artifact);
      } else {
        next.delete(artifact);
      }
      return next;
    });
  };

  const exportPagesByIds = async () => {
    let pageIds: number[];
    try {
      pageIds = parsePageIdInput(pageIdExportInput);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "page ID 列表无效。");
      return;
    }

    setIsExportingPageIds(true);
    try {
      const { blob, filename } = await api.exportSitePagesByIds(siteId, {
        pageIds,
        artifacts: [...selectedPageIdExportArtifacts],
      });
      downloadBlob(blob, filename);
      setPageIdExportOpen(false);
      toast.success(`已导出 ${pageIds.length} 个 page ID 对应的页面。`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导出失败。");
    } finally {
      setIsExportingPageIds(false);
    }
  };

  const totalPages = Math.max(Math.ceil(total / pageSize), 1);
  const selectedStatusLabel = statusFilterLabel(statuses);

  const toggleStatus = (value: string) => {
    setPage(1);
    setStatuses((current) =>
      current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value],
    );
  };

  useEffect(() => {
    setJumpPage(String(page));
  }, [page]);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  const submitJumpPage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextPage = Number.parseInt(jumpPage, 10);
    if (Number.isNaN(nextPage)) {
      setJumpPage(String(page));
      return;
    }
    const clampedPage = Math.min(Math.max(nextPage, 1), totalPages);
    setPage(clampedPage);
    setJumpPage(String(clampedPage));
  };

  const submitPageSize = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextPageSize = Number.parseInt(pageSizeInput, 10);
    if (Number.isNaN(nextPageSize)) {
      setPageSizeInput(String(pageSize));
      return;
    }
    const clampedPageSize = Math.min(Math.max(nextPageSize, minPageSize), maxPageSize);
    setPageSize(clampedPageSize);
    setPageSizeInput(String(clampedPageSize));
    setPage(1);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-baseline justify-between gap-4 space-y-0">
          <div className="flex items-baseline gap-2">
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {crawlRunId && <Badge variant="secondary">Run #{crawlRunId}</Badge>}
            {enableExport && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setPageIdExportOpen(true)}
                  disabled={isExportingPageIds}
                >
                  {isExportingPageIds ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                  按page_id导出页面
                </Button>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={exportPages} disabled={isExporting}>
                  <Download className="w-3.5 h-3.5" />
                  {isExporting ? "导出中..." : "导出 XLSX"}
                </Button>
              </>
            )}
            {onRecrawlStarted && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setViewSelectedOpen(true)}
                  disabled={selectedPages.size === 0}
                >
                  查看已选 ({selectedPages.size})
                </Button>
                <Button
                  size="sm"
                  className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white"
                  onClick={openRecrawlDialog}
                  disabled={selectedPages.size === 0}
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  重跑已选 ({selectedPages.size})
                </Button>
              </>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr_1fr_1fr_auto]">
            <div className="relative">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input className="pl-9" placeholder="搜索 URL 或标题" value={query} onChange={(event) => { setPage(1); setQuery(event.target.value); }} />
            </div>
            <details className="relative">
              <summary className="flex h-10 cursor-pointer list-none items-center justify-between gap-2 rounded-md border bg-background px-3 text-sm">
                <span className="truncate">{selectedStatusLabel}</span>
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              </summary>
              <div className="absolute z-20 mt-2 w-56 rounded-md border bg-background p-2 text-sm shadow-md">
                <button
                  type="button"
                  className="mb-1 w-full rounded px-2 py-1.5 text-left hover:bg-muted"
                  onClick={() => { setPage(1); setStatuses([]); }}
                >
                  全部状态
                </button>
                {statusOptions.filter((option) => option.value).map((option) => (
                  <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-muted">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={statuses.includes(option.value)}
                      onChange={() => toggleStatus(option.value)}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            </details>
            <select className="h-10 rounded-md border bg-background px-3 text-sm" value={pendingReason} onChange={(event) => { setPage(1); setPendingReason(event.target.value); }}>
              {pendingReasonOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <Input placeholder="Label 过滤" value={label} onChange={(event) => { setPage(1); setLabel(event.target.value); }} />
            <Button variant="outline" className="gap-2" onClick={() => { setPage(1); setQuery(""); setStatuses([]); setLabel(""); setPendingReason(""); }}>
              <Filter className="w-4 h-4" />
              重置
            </Button>
          </div>

          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  {onRecrawlStarted && (
                    <TableHead className="w-10">
                      <input
                        type="checkbox"
                        className="h-4 w-4 cursor-pointer"
                        checked={allCurrentSelected}
                        onChange={toggleAll}
                        title="全选当前页"
                      />
                    </TableHead>
                  )}
                  <TableHead>页面</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>发现来源</TableHead>
                  <TableHead>采集摘要</TableHead>
                  <TableHead>最近更新</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pages.map((item) => (
                  <TableRow key={item.sitePageId} className="cursor-pointer hover:bg-muted/50">
                    {onRecrawlStarted && (
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          className="h-4 w-4 cursor-pointer"
                          checked={selectedPages.has(item.sitePageId)}
                          onChange={() => togglePage(item)}
                        />
                      </TableCell>
                    )}
                    <TableCell className="max-w-[360px]" onClick={() => openDetail(item.sitePageId)}>
                      <div className="font-medium truncate">{item.title}</div>
                      <div className="text-xs text-muted-foreground truncate">{item.url}</div>
                    </TableCell>
                    <TableCell onClick={() => openDetail(item.sitePageId)}><Badge variant={statusVariant(item)}>{item.businessStatus}</Badge></TableCell>
                    <TableCell className="text-muted-foreground" onClick={() => openDetail(item.sitePageId)}>{item.discoverySource}</TableCell>
                    <TableCell className="text-muted-foreground" onClick={() => openDetail(item.sitePageId)}>{item.captureSummary}</TableCell>
                    <TableCell className="text-muted-foreground" onClick={() => openDetail(item.sitePageId)}>{formatDate(item.latestHandledAt)}</TableCell>
                  </TableRow>
                ))}
                {pages.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={onRecrawlStarted ? 6 : 5} className="py-10 text-center text-muted-foreground">
                      {isLoading ? "加载中..." : "暂无符合条件的页面。"}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <div>共 {total} 条，当前第 {page} / {totalPages} 页，每页 {pageSize} 条</div>
            <div className="flex flex-wrap items-center gap-2">
              <form className="flex items-center gap-2" onSubmit={submitPageSize}>
                <span className="whitespace-nowrap">每页</span>
                <Input
                  className="h-9 w-20 text-center"
                  type="number"
                  min={minPageSize}
                  max={maxPageSize}
                  value={pageSizeInput}
                  onChange={(event) => setPageSizeInput(event.target.value)}
                  aria-label="每页条数"
                />
                <span className="whitespace-nowrap">条</span>
                <Button variant="outline" size="sm" type="submit">应用</Button>
              </form>
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((current) => Math.max(current - 1, 1))}>上一页</Button>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(current + 1, totalPages))}>下一页</Button>
              <form className="flex items-center gap-2" onSubmit={submitJumpPage}>
                <span className="whitespace-nowrap">跳至</span>
                <Input
                  className="h-9 w-20 text-center"
                  type="number"
                  min={1}
                  max={totalPages}
                  value={jumpPage}
                  onChange={(event) => setJumpPage(event.target.value)}
                  aria-label="跳转页码"
                />
                <span className="whitespace-nowrap">页</span>
                <Button variant="outline" size="sm" type="submit">跳转</Button>
              </form>
            </div>
          </div>
        </CardContent>
      </Card>

      <PageDetailDialog detail={detail} onClose={() => setDetail(null)} />

      <Dialog open={pageIdExportOpen} onOpenChange={setPageIdExportOpen}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-xl min-w-0 overflow-hidden">
          <DialogHeader>
            <DialogTitle>按page_id导出页面</DialogTitle>
            <DialogDescription>输入 page ID 列表，支持逗号、空格或换行分隔。</DialogDescription>
          </DialogHeader>
          <div className="space-y-5 py-2">
            <div className="space-y-2">
              <Label htmlFor="page-id-export-input">page ID 列表</Label>
              <textarea
                id="page-id-export-input"
                className="min-h-36 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                placeholder={"例如：\n101, 102 103\n104"}
                value={pageIdExportInput}
                onChange={(event) => setPageIdExportInput(event.target.value)}
              />
            </div>

            <div className="space-y-3">
              <Label>Artifacts</Label>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {exportArtifactOptions.map((option) => (
                  <label key={option.value} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedPageIdExportArtifacts.has(option.value)}
                      onChange={(event) => togglePageIdExportArtifact(option.value, event.target.checked)}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPageIdExportOpen(false)} disabled={isExportingPageIds}>取消</Button>
            <Button onClick={exportPagesByIds} disabled={isExportingPageIds}>
              {isExportingPageIds ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
              开始导出
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 查看已选对话框 */}
      <Dialog open={viewSelectedOpen} onOpenChange={setViewSelectedOpen}>
        <DialogContent className="max-w-2xl max-h-[70vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>已选页面（{selectedPages.size} 个）</DialogTitle>
          </DialogHeader>
          <div className="space-y-1">
            {[...selectedPages.entries()].map(([id, p]) => (
              <div key={id} className="flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-sm">
                <div className="min-w-0">
                  <div className="font-medium truncate">{p.title}</div>
                  <div className="text-xs text-muted-foreground truncate">{p.url}</div>
                </div>
                <button
                  type="button"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => setSelectedPages((prev) => { const next = new Map(prev); next.delete(id); return next; })}
                >
                  <XCircle className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* 重跑已选确认对话框 */}
      <Dialog open={confirmRecrawlOpen} onOpenChange={setConfirmRecrawlOpen}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-lg min-w-0 overflow-hidden">
          <DialogHeader>
            <DialogTitle>确认重跑已选页面</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <p>即将提交重新爬取任务，爬取深度固定为 0（仅爬取下方 URL，不递归）。</p>
            <div className="space-y-2">
              <Label htmlFor="recrawl-update-policy">更新策略</Label>
              <select
                id="recrawl-update-policy"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={recrawlUpdatePolicy}
                onChange={(event) => setRecrawlUpdatePolicy(event.target.value as UpdatePolicy)}
              >
                {updatePolicyOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="recrawl-stale-days">过期天数</Label>
              <Input
                id="recrawl-stale-days"
                type="number"
                min="1"
                placeholder="仅更新策略为过期时使用"
                value={recrawlStaleAfterDays}
                onChange={(event) => setRecrawlStaleAfterDays(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="recrawl-urls">URL 列表</Label>
              <textarea
                id="recrawl-urls"
                className="min-h-40 w-full resize-y rounded-md border bg-background px-3 py-2 text-xs leading-5 outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                placeholder={"每行一个 URL"}
                value={recrawlUrlsInput}
                onChange={(event) => setRecrawlUrlsInput(event.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setConfirmRecrawlOpen(false)} disabled={isSubmittingRecrawl}>取消</Button>
              <Button className="gap-2 bg-amber-600 hover:bg-amber-700 text-white" onClick={submitRecrawl} disabled={isSubmittingRecrawl}>
                {isSubmittingRecrawl ? <RotateCcw className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                确认提交
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
