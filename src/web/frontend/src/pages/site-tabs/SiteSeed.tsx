import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { SiteRunListItem } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Play, RefreshCw, ScrollText, FileText, AlertCircle } from "lucide-react";
import { PageReview } from "./PageReview";
import { RunLogs } from "@/components/RunLogs";

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "-";
}

export function SiteSeed({ siteId }: { siteId: number }) {
  const [isStarting, setIsStarting] = useState(false);
  const [runs, setRuns] = useState<SiteRunListItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<"pages" | "logs">("pages");
  const [targetSuccessCount, setTargetSuccessCount] = useState("");

  const loadRuns = () => {
    api.getSiteRuns(siteId).then((data) => {
      const seedRuns = (data.items || []).filter((run: SiteRunListItem) => run.runType === "seed_run");
      setRuns(seedRuns);
      setSelectedRunId((current) => current ?? seedRuns[0]?.runId ?? null);
    });
  };

  useEffect(() => {
    loadRuns();
  }, [siteId]);

  const startSeed = async () => {
    setIsStarting(true);
    try {
      const result = await api.startSeedRun(siteId, {
        targetSuccessCount: targetSuccessCount ? Number(targetSuccessCount) : null,
      });
      setSelectedRunId(result.runId);
      setActiveTab("logs");
      loadRuns();
    } finally {
      setIsStarting(false);
    }
  };

  const selectedRun = runs.find((r) => r.runId === selectedRunId);

  return (
    <div className="space-y-6">
      <Card className="border-green-600/20">
        <CardHeader className="flex flex-row items-baseline gap-2 space-y-0">
          <CardTitle className="flex items-center gap-2"><Play className="w-5 h-5" /> 初步摸底</CardTitle>
          <CardDescription>
            从 seed URL 和 sitemap 收集初始 inventory，只执行基础爬取和规则判断。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-[1fr_240px_auto]">
          <div className="text-sm text-muted-foreground">
            适合在规则还不确定时先看页面分布，之后再调整抓取范围。
          </div>
          <div className="space-y-2">
            <Label>目标成功页数(软上限)</Label>
            <Input type="number" min="1" placeholder="不限" value={targetSuccessCount} onChange={(event) => setTargetSuccessCount(event.target.value)} />
          </div>
          <div className="flex items-end">
            <Button className="w-full gap-2 bg-green-600 hover:bg-green-700 text-white" onClick={startSeed} disabled={isStarting}>
              {isStarting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              启动初步摸底
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-baseline gap-2 space-y-0">
          <CardTitle>摸底运行记录</CardTitle>
          <CardDescription>点击某次运行，在下方查看页面复核或运行日志。</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>成功 / 待确认 / 拒绝</TableHead>
                <TableHead>目标成功数</TableHead>
                <TableHead>开始时间</TableHead>
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
                  <TableCell>{run.successfulPages} / {run.pendingPages} / {run.deniedPages}</TableCell>
                  <TableCell>{run.targetSuccessCount ?? "不限"}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(run.startedAt)}</TableCell>
                </TableRow>
              ))}
              {runs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">还没有初步摸底记录。</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {selectedRunId && (
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "pages" | "logs")}>
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-sm text-muted-foreground">
              Run #{selectedRunId}{selectedRun?.status === "failed" ? " · 运行失败" : ""}
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
