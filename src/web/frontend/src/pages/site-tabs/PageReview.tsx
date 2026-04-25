import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { api } from "@/lib/api";
import type { ProcessingState, SitePageDetail, SitePageListRow } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { RunLogs } from "@/components/RunLogs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CheckCircle2, CircleDashed, Filter, History, Image, ScrollText, Search, XCircle } from "lucide-react";

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

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "-";
}

function statusVariant(page: SitePageListRow): "default" | "secondary" | "destructive" | "outline" {
  if (page.businessStatus === "不采集") return "destructive";
  if (page.needsReview) return "secondary";
  if (page.businessStatus === "已完成采集") return "default";
  return "outline";
}

type PreviewKind = "base" | "markdown" | "screenshot";
type PreviewMode = "text" | "markdown";

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
      className={`rounded-lg border bg-muted/20 p-4 space-y-3 text-left transition-colors hover:bg-muted/40 ${active ? "border-primary ring-2 ring-primary/20" : ""}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 font-semibold">
          <Icon className={state.succeeded ? "w-4 h-4 text-green-600" : state.shouldRun ? "w-4 h-4 text-orange-600" : "w-4 h-4 text-muted-foreground"} />
          {state.label}
        </div>
        <Badge variant={state.succeeded ? "default" : state.shouldRun ? "secondary" : "outline"}>
          {state.shouldRun ? "应该运行" : "不要求运行"}
        </Badge>
      </div>
      <div className="grid gap-2 text-sm text-muted-foreground">
        <div>结果：<span className="text-foreground">{state.statusLabel}</span></div>
        <div>原因：<span className="text-foreground">{state.reason}</span></div>
        <div>Run：<span className="text-foreground">{state.runId ?? "-"}</span></div>
        <div>时间：<span className="text-foreground">{formatDate(state.handledAt)}</span></div>
        {state.outputPath && <div className="break-all">输出：<span className="text-foreground">{state.outputPath}</span></div>}
      </div>
    </button>
  );
}

function MarkdownPreview({ content }: { content: string }) {
  const lines = content.split("\n");
  const blocks: ReactElement[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.startsWith("```")) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      blocks.push(
        <pre key={index} className="overflow-auto rounded-md bg-muted p-3 text-xs">
          {codeLines.join("\n")}
        </pre>,
      );
    } else if (line.startsWith("### ")) {
      blocks.push(<h3 key={index} className="text-sm font-semibold">{line.slice(4)}</h3>);
    } else if (line.startsWith("## ")) {
      blocks.push(<h2 key={index} className="text-base font-semibold">{line.slice(3)}</h2>);
    } else if (line.startsWith("# ")) {
      blocks.push(<h1 key={index} className="text-lg font-semibold">{line.slice(2)}</h1>);
    } else if (line.startsWith("- ")) {
      const items: string[] = [];
      while (index < lines.length && lines[index].startsWith("- ")) {
        items.push(lines[index].slice(2));
        index += 1;
      }
      blocks.push(
        <ul key={index} className="list-disc space-y-1 pl-5 text-sm">
          {items.map((item) => <li key={item}>{item}</li>)}
        </ul>,
      );
      continue;
    } else if (line.trim()) {
      blocks.push(<p key={index} className="text-sm leading-6">{line}</p>);
    }

    index += 1;
  }

  return <div className="space-y-3">{blocks.length > 0 ? blocks : <div className="text-sm text-muted-foreground">暂无内容。</div>}</div>;
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
        : detail.latestPreviews.screenshot;
  const title =
    activePreview === "base"
      ? "基础爬取预览"
      : activePreview === "markdown"
        ? "Markdown 预览"
        : "Screenshot 预览";
  const textContent = "content" in preview ? preview.content : null;

  return (
    <div className="w-full min-w-0 overflow-hidden rounded-xl border p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{title}</div>
          <div className="text-xs text-muted-foreground truncate">{preview.outputPath || "暂无输出文件"}</div>
        </div>
        {activePreview !== "screenshot" && (
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

  useEffect(() => {
    setActivePreview("base");
    setPreviewMode("text");
    setExpandedLogRunId(null);
  }, [detail?.sitePageId]);

  return (
    <Dialog open={!!detail} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[92vw] w-[92vw] max-h-[90vh] overflow-y-auto overflow-x-hidden grid-cols-1">
        <DialogHeader>
          <DialogTitle>页面详情</DialogTitle>
        </DialogHeader>
        {detail && (
          <div className="space-y-6 min-w-0 overflow-hidden">
            <div className="rounded-xl border bg-muted/20 p-4 space-y-3">
              <div>
                <div className="text-lg font-semibold">{detail.title}</div>
                <div className="text-sm text-muted-foreground break-all">{detail.url}</div>
              </div>
              <div className="grid gap-3 md:grid-cols-3 text-sm">
                <div>业务状态：<Badge variant="outline">{detail.businessStatus}</Badge></div>
                <div>发现来源：{detail.discoverySource}</div>
                <div>发现时间：{formatDate(detail.firstDiscoveredAt)}</div>
              </div>
              {detail.latestTags.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {detail.latestTags.map((tag) => <Badge key={tag} variant="secondary">{tag}</Badge>)}
                </div>
              )}
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <ProcessingCard state={detail.latestBase} active={activePreview === "base"} onSelect={() => setActivePreview("base")} />
              <ProcessingCard state={detail.latestMarkdown} active={activePreview === "markdown"} onSelect={() => setActivePreview("markdown")} />
              <ProcessingCard state={detail.latestScreenshot} active={activePreview === "screenshot"} onSelect={() => setActivePreview("screenshot")} />
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
      </DialogContent>
    </Dialog>
  );
}

export function PageReview({
  siteId,
  crawlRunId,
  title = "页面清单",
  description = "以 site_pages 为基本单位查看站点页面。",
}: {
  siteId: number;
  crawlRunId?: number;
  title?: string;
  description?: string;
}) {
  const [pages, setPages] = useState<SitePageListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [tag, setTag] = useState("");
  const [pendingReason, setPendingReason] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [detail, setDetail] = useState<SitePageDetail | null>(null);
  const pageSize = 20;

  useEffect(() => {
    setIsLoading(true);
    api.getSitePages(siteId, {
      page,
      pageSize,
      query,
      status,
      tag,
      pendingReason,
      crawlRunId,
    })
      .then((data) => {
        setPages(data.rows || []);
        setTotal(data.total || 0);
      })
      .finally(() => setIsLoading(false));
  }, [crawlRunId, page, pendingReason, query, siteId, status, tag]);

  const openDetail = async (sitePageId: number) => {
    const nextDetail = await api.getSitePageDetail(siteId, sitePageId);
    setDetail(nextDetail);
  };

  const totalPages = Math.max(Math.ceil(total / pageSize), 1);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-baseline justify-between gap-4 space-y-0">
          <div className="flex items-baseline gap-2">
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          {crawlRunId && <Badge variant="secondary" className="shrink-0">Run #{crawlRunId}</Badge>}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr_1fr_1fr_auto]">
            <div className="relative">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input className="pl-9" placeholder="搜索 URL 或标题" value={query} onChange={(event) => { setPage(1); setQuery(event.target.value); }} />
            </div>
            <select className="h-10 rounded-md border bg-background px-3 text-sm" value={status} onChange={(event) => { setPage(1); setStatus(event.target.value); }}>
              {statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <select className="h-10 rounded-md border bg-background px-3 text-sm" value={pendingReason} onChange={(event) => { setPage(1); setPendingReason(event.target.value); }}>
              {pendingReasonOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <Input placeholder="Tag 过滤" value={tag} onChange={(event) => { setPage(1); setTag(event.target.value); }} />
            <Button variant="outline" className="gap-2" onClick={() => { setPage(1); setQuery(""); setStatus(""); setTag(""); setPendingReason(""); }}>
              <Filter className="w-4 h-4" />
              重置
            </Button>
          </div>

          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>页面</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>发现来源</TableHead>
                  <TableHead>采集摘要</TableHead>
                  <TableHead>最近更新</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pages.map((item) => (
                  <TableRow key={item.sitePageId} className="cursor-pointer hover:bg-muted/50" onClick={() => openDetail(item.sitePageId)}>
                    <TableCell className="max-w-[360px]">
                      <div className="font-medium truncate">{item.title}</div>
                      <div className="text-xs text-muted-foreground truncate">{item.url}</div>
                    </TableCell>
                    <TableCell><Badge variant={statusVariant(item)}>{item.businessStatus}</Badge></TableCell>
                    <TableCell className="text-muted-foreground">{item.discoverySource}</TableCell>
                    <TableCell className="text-muted-foreground">{item.captureSummary}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(item.latestHandledAt)}</TableCell>
                  </TableRow>
                ))}
                {pages.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                      {isLoading ? "加载中..." : "暂无符合条件的页面。"}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <div>共 {total} 条，当前第 {page} / {totalPages} 页</div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((current) => Math.max(current - 1, 1))}>上一页</Button>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(current + 1, totalPages))}>下一页</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <PageDetailDialog detail={detail} onClose={() => setDetail(null)} />
    </div>
  );
}
