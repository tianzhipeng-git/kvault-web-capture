import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { SiteRunListItem } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Database, Play, RefreshCw } from "lucide-react";
import { PageReview } from "./PageReview";

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "-";
}

export function SiteCrawl({ siteId }: { siteId: number }) {
  const [isStarting, setIsStarting] = useState(false);
  const [runs, setRuns] = useState<SiteRunListItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [updatePolicy, setUpdatePolicy] = useState("skip_existing");
  const [targetSuccessCount, setTargetSuccessCount] = useState("");
  const [staleAfterDays, setStaleAfterDays] = useState("");

  const loadRuns = () => {
    api.getSiteRuns(siteId).then((data) => {
      const crawlRuns = (data.items || []).filter((run: SiteRunListItem) => run.runType === "crawl_run");
      setRuns(crawlRuns);
      setSelectedRunId((current) => current ?? crawlRuns[0]?.runId ?? null);
    });
  };

  useEffect(() => {
    loadRuns();
  }, [siteId]);

  const startCrawl = async () => {
    setIsStarting(true);
    try {
      const staleAfterMs = staleAfterDays ? Number(staleAfterDays) * 24 * 60 * 60 * 1000 : null;
      const result = await api.startCrawlRun(siteId, {
        updatePolicy,
        targetSuccessCount: targetSuccessCount ? Number(targetSuccessCount) : null,
        staleAfterMs,
      });
      setSelectedRunId(result.runId);
      loadRuns();
    } finally {
      setIsStarting(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card className="border-green-600/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Database className="w-5 h-5" /> 正式采集</CardTitle>
          <CardDescription>
            对允许采集的页面执行完整 artifact 阶段，并用目标成功数和更新策略控制单轮采集范围。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-[1fr_1fr_1fr_auto]">
          <div className="space-y-2">
            <Label>更新策略</Label>
            <select className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={updatePolicy} onChange={(event) => setUpdatePolicy(event.target.value)}>
              <option value="skip_existing">跳过已有成功结果</option>
              <option value="force_recrawl_all">强制重新采集</option>
              <option value="stale_after_duration">超过时间后更新</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label>目标成功页数</Label>
            <Input type="number" min="1" placeholder="不限" value={targetSuccessCount} onChange={(event) => setTargetSuccessCount(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>过期天数</Label>
            <Input type="number" min="1" placeholder="仅更新策略为过期时使用" value={staleAfterDays} onChange={(event) => setStaleAfterDays(event.target.value)} />
          </div>
          <div className="flex items-end">
            <Button className="w-full gap-2 bg-green-600 hover:bg-green-700 text-white" onClick={startCrawl} disabled={isStarting}>
              {isStarting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              启动正式采集
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>正式采集运行记录</CardTitle>
          <CardDescription>点击某次运行，在下方按 pages 粒度复核这次运行触达的页面。</CardDescription>
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
                  onClick={() => setSelectedRunId(run.runId)}
                >
                  <TableCell className="font-medium">#{run.runId}</TableCell>
                  <TableCell><Badge variant={run.status === "failed" ? "destructive" : run.status === "running" ? "secondary" : "default"}>{run.statusLabel}</Badge></TableCell>
                  <TableCell>{run.successfulPages} / {run.pendingPages} / {run.deniedPages}</TableCell>
                  <TableCell>{run.targetSuccessCount ?? "不限"}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(run.startedAt)}</TableCell>
                </TableRow>
              ))}
              {runs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">还没有正式采集记录。</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {selectedRunId && (
        <PageReview
          siteId={siteId}
          crawlRunId={selectedRunId}
          title={`Run #${selectedRunId} 页面复核`}
          description="这里复用页面清单组件，但只展示该 crawl run 触达过的 site_pages。"
        />
      )}
    </div>
  );
}
