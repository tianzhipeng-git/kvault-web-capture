import { useEffect, useMemo, useState } from "react";
import { CloudUpload, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import type { VaultExportTask, VaultExportPhase } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const runningPhases = new Set<VaultExportPhase>(["queued", "exporting_zip", "uploading_drive"]);

function phaseLabel(phase: VaultExportPhase): string {
  switch (phase) {
    case "queued":
      return "排队中";
    case "exporting_zip":
      return "打包中";
    case "uploading_drive":
      return "上传中";
    case "succeeded":
      return "成功";
    case "failed":
      return "失败";
  }
}

function phaseVariant(phase: VaultExportPhase): "default" | "secondary" | "destructive" | "outline" {
  if (phase === "succeeded") return "default";
  if (phase === "failed") return "destructive";
  if (runningPhases.has(phase)) return "secondary";
  return "outline";
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "-";
}

export function ExportRecords() {
  const [tasks, setTasks] = useState<VaultExportTask[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const hasRunningTask = useMemo(() => tasks.some((task) => runningPhases.has(task.phase)), [tasks]);

  const loadTasks = async () => {
    setIsLoading(true);
    try {
      const result = await api.getVaultExportTasks();
      setTasks(result.items);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadTasks();
  }, []);

  useEffect(() => {
    if (!hasRunningTask) return;
    const timer = window.setInterval(loadTasks, 1500);
    return () => window.clearInterval(timer);
  }, [hasRunningTask]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">导出记录</h1>
          <p className="mt-1 text-muted-foreground">统一查看 Vault Drive ZIP 导出的进度、结果和错误。</p>
        </div>
        <Button variant="outline" className="gap-2" onClick={loadTasks} disabled={isLoading}>
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          刷新
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CloudUpload className="h-5 w-5" />
            Vault Drive 导出
          </CardTitle>
          <CardDescription>当前进程内最近 20 条导出记录。</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>状态</TableHead>
                  <TableHead>目标 Project</TableHead>
                  <TableHead>文件</TableHead>
                  <TableHead>开始时间</TableHead>
                  <TableHead>完成时间</TableHead>
                  <TableHead>结果</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.map((task) => (
                  <TableRow key={task.taskId}>
                    <TableCell className="whitespace-nowrap">
                      <Badge variant={phaseVariant(task.phase)}>{phaseLabel(task.phase)}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{task.targetProject.name}</div>
                      <div className="text-xs text-muted-foreground">{task.targetProject.key}</div>
                    </TableCell>
                    <TableCell className="max-w-72">
                      <div className="truncate" title={task.fileName ?? undefined}>{task.fileName ?? "-"}</div>
                      <div className="text-xs text-muted-foreground">{task.message}</div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(task.startedAt)}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(task.finishedAt)}</TableCell>
                    <TableCell className="max-w-80">
                      {task.uploadResult?.webViewLink ? (
                        <a className="inline-flex items-center gap-1 text-primary underline" href={task.uploadResult.webViewLink} target="_blank" rel="noreferrer">
                          打开文件
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      ) : task.errorMessage ? (
                        <span className="text-destructive">{task.errorMessage}</span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {tasks.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                      暂无导出记录。
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
