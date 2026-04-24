import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { SiteRunListItem } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Play, RefreshCw } from "lucide-react";
import { PageReview } from "./PageReview";

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "-";
}

export function SiteSeed({ siteId }: { siteId: number }) {
  const [isStarting, setIsStarting] = useState(false);
  const [runs, setRuns] = useState<SiteRunListItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);

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
      const result = await api.startSeedRun(siteId);
      setSelectedRunId(result.runId);
      loadRuns();
    } finally {
      setIsStarting(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card className="border-blue-500/20">
        <CardHeader>
          <CardTitle>初步摸底</CardTitle>
          <CardDescription>
            从 seed URL 和 sitemap 收集初始 inventory，只执行基础爬取、分类和规则判断，不触发 Markdown / Screenshot 阶段。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-4">
          <div className="text-sm text-muted-foreground">
            适合在规则还不确定时先看页面分布，之后到“规则配置”调整范围。
          </div>
          <Button className="gap-2" onClick={startSeed} disabled={isStarting}>
            {isStarting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            启动初步摸底
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>摸底运行记录</CardTitle>
          <CardDescription>点击某次运行，在下方按 pages 粒度复核这次运行触达的页面。</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>成功 / 待确认 / 拒绝</TableHead>
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
                  <TableCell className="text-muted-foreground">{formatDate(run.startedAt)}</TableCell>
                </TableRow>
              ))}
              {runs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">还没有初步摸底记录。</TableCell>
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
          description="这里复用页面清单组件，但只展示该 seed run 触达过的 site_pages。"
        />
      )}
    </div>
  );
}
