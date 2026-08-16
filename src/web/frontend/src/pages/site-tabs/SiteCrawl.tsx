import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "@/lib/api";
import type { SiteRunListItem, UpdatePolicy } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Database, Play, RefreshCw, ScrollText, FileText, AlertCircle, Square } from "lucide-react";
import { toast } from "sonner";
import { PageReview } from "./PageReview";
import { RunLogs } from "@/components/RunLogs";

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "-";
}

function formatDuration(startedAt: string, finishedAt: string | null, now: number): string {
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : now;
  const seconds = Math.max(Math.floor((end - start) / 1000), 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours > 0) {
    return `${hours}小时${minutes}分`;
  }

  if (minutes > 0) {
    return `${minutes}分${remainingSeconds}秒`;
  }

  return `${remainingSeconds}秒`;
}

function updatePolicyLabel(value: UpdatePolicy): string {
  switch (value) {
    case "force_recrawl_all":
      return "强制重新采集";
    case "stale_after_duration":
      return "超过时间后更新";
    default:
      return "跳过已有成功结果";
  }
}

const runPageSize = 10;

export function SiteCrawl({ siteId }: { siteId: number }) {
  const [searchParams] = useSearchParams();
  const queryRunId = Number(searchParams.get("runId") ?? "");
  const [isStarting, setIsStarting] = useState(false);
  const [runs, setRuns] = useState<SiteRunListItem[]>([]);
  const [runPage, setRunPage] = useState(1);
  const [runTotal, setRunTotal] = useState(0);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<"pages" | "logs">("pages");
  const [updatePolicy, setUpdatePolicy] = useState("skip_existing");
  const [skipBase, setSkipBase] = useState(true);
  const [targetSuccessCount, setTargetSuccessCount] = useState("");
  const [staleAfterDays, setStaleAfterDays] = useState("");
  const [cancellingRunId, setCancellingRunId] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const loadRuns = () => {
    api.getSiteRuns(siteId, { runType: "crawl_run", page: runPage, pageSize: runPageSize }).then((data) => {
      const crawlRuns = data.items || [];
      setRuns(crawlRuns);
      setRunTotal(data.total);
      setSelectedRunId((current) => {
        if (Number.isInteger(queryRunId) && crawlRuns.some((run: SiteRunListItem) => run.runId === queryRunId)) {
          return queryRunId;
        }
        if (current && crawlRuns.some((run: SiteRunListItem) => run.runId === current)) {
          return current;
        }
        return crawlRuns[0]?.runId ?? null;
      });
    });
  };

  useEffect(() => {
    loadRuns();
  }, [queryRunId, runPage, siteId]);

  useEffect(() => {
    setRunPage(1);
  }, [siteId]);

  const hasRunningRun = runs.some((run) => run.status === "running");

  useEffect(() => {
    if (!hasRunningRun) {
      return;
    }

    const timer = window.setInterval(() => {
      setNow(Date.now());
      loadRuns();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [hasRunningRun, queryRunId, runPage, siteId]);

  const startCrawl = async () => {
    setIsStarting(true);
    try {
      const staleAfterMs = staleAfterDays ? Number(staleAfterDays) * 24 * 60 * 60 * 1000 : null;
      const result = await api.startCrawlRun(siteId, {
        updatePolicy,
        skipBase,
        targetSuccessCount: targetSuccessCount ? Number(targetSuccessCount) : null,
        staleAfterMs,
      });
      setSelectedRunId(result.runId);
      setActiveTab("logs");
      loadRuns();
    } finally {
      setIsStarting(false);
    }
  };

  const cancelRun = async (runId: number) => {
    setCancellingRunId(runId);
    try {
      const result = await api.cancelRun(runId);
      toast.success(result.status === "cancelled" ? "已清理失联运行状态。" : "已发送停止请求。");
      loadRuns();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "停止失败。");
      loadRuns();
    } finally {
      setCancellingRunId(null);
    }
  };

  const selectedRun = runs.find((r) => r.runId === selectedRunId);
  const runTotalPages = Math.max(Math.ceil(runTotal / runPageSize), 1);

  return (
    <div className="space-y-6">
      <Card className="border-green-600/20">
        <CardHeader className="flex flex-row items-baseline gap-2 space-y-0">
          <CardTitle className="flex items-center gap-2"><Database className="w-5 h-5" /> 正式采集</CardTitle>
          <CardDescription>
            对允许采集的页面执行完整 artifact 阶段，并用目标成功数和更新策略控制范围。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-[1fr_1fr_1fr_1fr_auto]">
          <div className="space-y-2">
            <Label>更新策略</Label>
            <select className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={updatePolicy} onChange={(event) => setUpdatePolicy(event.target.value)}>
              <option value="skip_existing">跳过已有成功结果</option>
              <option value="force_recrawl_all">强制重新采集</option>
              <option value="stale_after_duration">超过时间后更新</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label>目标成功页数(软上限)</Label>
            <Input type="number" min="1" placeholder="不限" value={targetSuccessCount} onChange={(event) => setTargetSuccessCount(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>过期天数</Label>
            <Input type="number" min="1" placeholder="仅更新策略为过期时使用" value={staleAfterDays} onChange={(event) => setStaleAfterDays(event.target.value)} />
          </div>
          <label className="flex items-end gap-2 pb-2 text-sm">
            <input type="checkbox" checked={skipBase} onChange={(event) => setSkipBase(event.target.checked)} />
            跳过 Base（复用已有结果）
          </label>
          <div className="flex items-end">
            <Button className="w-full gap-2 bg-green-600 hover:bg-green-700 text-white" onClick={startCrawl} disabled={isStarting}>
              {isStarting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              启动正式采集
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-baseline gap-2 space-y-0">
          <CardTitle>正式采集运行记录</CardTitle>
          <CardDescription>点击某次运行，在下方查看页面复核或运行日志。</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>页面 成功 / 失败</TableHead>
                <TableHead>制品 成功 / 失败</TableHead>
                <TableHead>待确认 / 拒绝</TableHead>
                <TableHead>目标成功数</TableHead>
                <TableHead>更新策略</TableHead>
                <TableHead>执行时长</TableHead>
                <TableHead>开始时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow
                  key={run.runId}
                  className={selectedRunId === run.runId ? "cursor-pointer bg-muted/60" : "cursor-pointer hover:bg-muted/50"}
                  onClick={() => { setSelectedRunId(run.runId); }}
                >
                  <TableCell className="font-medium">#{run.runId}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <Badge variant={run.status === "failed" ? "destructive" : run.status === "running" ? "secondary" : "default"}>
                        {run.statusLabel}
                      </Badge>
                      {run.status === "failed" && run.errorMessage && (
                        <span title={run.errorMessage}>
                          <AlertCircle className="w-3.5 h-3.5 text-destructive" />
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>{run.successfulPages} / {run.failedPages}</TableCell>
                  <TableCell>{run.successfulArtifacts} / {run.failedArtifacts}</TableCell>
                  <TableCell>{run.pendingPages} / {run.deniedPages}</TableCell>
                  <TableCell>{run.targetSuccessCount ?? "不限"}</TableCell>
                  <TableCell className="text-muted-foreground">{updatePolicyLabel(run.updatePolicy)}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDuration(run.startedAt, run.finishedAt, now)}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(run.startedAt)}</TableCell>
                  <TableCell className="text-right">
                    {run.status === "running" && (
                      <Button
                        variant="destructive"
                        size="sm"
                        className="h-8 gap-1.5"
                        disabled={cancellingRunId === run.runId}
                        onClick={(event) => {
                          event.stopPropagation();
                          void cancelRun(run.runId);
                        }}
                      >
                        {cancellingRunId === run.runId ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Square className="w-3.5 h-3.5" />}
                        停止
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {runs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="py-8 text-center text-muted-foreground">还没有正式采集记录。</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <div className="mt-4 flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <div>共 {runTotal} 条，当前第 {runPage} / {runTotalPages} 页，每页 {runPageSize} 条</div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={runPage <= 1}
                onClick={() => setRunPage((current) => Math.max(current - 1, 1))}
              >
                上一页
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={runPage >= runTotalPages}
                onClick={() => setRunPage((current) => Math.min(current + 1, runTotalPages))}
              >
                下一页
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {selectedRunId && (
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "pages" | "logs")}>
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-sm text-muted-foreground">
              Run #{selectedRunId}{selectedRun?.status === "failed" ? " · 运行失败" : selectedRun?.status === "cancelled" ? " · 已取消" : ""}
            </h3>
            <TabsList>
              <TabsTrigger value="pages" className="gap-1.5 text-xs">
                <FileText className="w-3.5 h-3.5" /> 页面复核
              </TabsTrigger>
              <TabsTrigger value="logs" className="gap-1.5 text-xs">
                <ScrollText className="w-3.5 h-3.5" /> 运行日志
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="pages">
            <PageReview
              siteId={siteId}
              crawlRunId={selectedRunId}
              title={`Run #${selectedRunId} 页面复核`}
              description="检查本次运行爬取的页面情况"
              enableExport
            />
          </TabsContent>
          <TabsContent value="logs">
            <RunLogs runId={selectedRunId} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
