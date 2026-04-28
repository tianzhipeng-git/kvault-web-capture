import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { RunLogItem } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertCircle, CheckCircle2, Download, FileText, Info, RefreshCw, ScrollText, XCircle } from "lucide-react";

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function LevelIcon({ level }: { level: string }) {
  switch (level) {
    case "error":
      return <XCircle className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" />;
    case "warn":
      return <AlertCircle className="w-3.5 h-3.5 text-yellow-500 shrink-0 mt-0.5" />;
    case "info":
      return <Info className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />;
    default:
      return <CheckCircle2 className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />;
  }
}

function eventColor(event: string): string {
  if (event.includes("error") || event.includes("failed")) return "destructive";
  if (event.includes("started")) return "secondary";
  if (event.includes("finished") || event.includes("done")) return "default";
  return "outline";
}

function MetaDetail({ meta }: { meta: Record<string, unknown> | null }) {
  if (!meta) return null;
  const stack = typeof meta.stack === "string" ? meta.stack : null;
  const other = Object.entries(meta).filter(([k]) => k !== "stack");

  return (
    <div className="mt-1 pl-5 space-y-1">
      {other.length > 0 && (
        <div className="text-xs text-muted-foreground font-mono">
          {other.map(([k, v]) => (
            <span key={k} className="mr-3">
              <span className="opacity-60">{k}:</span>{" "}
              {typeof v === "object" ? JSON.stringify(v) : String(v)}
            </span>
          ))}
        </div>
      )}
      {stack && (
        <details className="group">
          <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground list-none flex items-center gap-1">
            <span className="border rounded px-1 py-px text-[10px]">stack trace</span>
          </summary>
          <pre className="mt-1 text-[11px] text-destructive/80 font-mono whitespace-pre-wrap bg-destructive/5 rounded p-2 overflow-x-auto">
            {stack}
          </pre>
        </details>
      )}
    </div>
  );
}

interface RunLogsProps {
  runId: number;
  sitePageId?: number;
  includeRunError?: boolean;
  /** If true, show logs inline without a Card wrapper */
  inline?: boolean;
}

type LogView = "events" | "runtime";

export function RunLogs({ runId, sitePageId, includeRunError = true, inline }: RunLogsProps) {
  const [logs, setLogs] = useState<RunLogItem[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeView, setActiveView] = useState<LogView>("events");
  const [runtimeLog, setRuntimeLog] = useState<{
    relativePath: string;
    content: string;
    truncated: boolean;
  } | null>(null);
  const [runtimeLogError, setRuntimeLogError] = useState<string | null>(null);
  const [runtimeLogLoading, setRuntimeLogLoading] = useState(false);
  const [runtimeLogDownloading, setRuntimeLogDownloading] = useState(false);

  const loadEventLogs = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getRunLogs(runId, { sitePageId });
      setLogs(data.items);
      setErrorMessage(data.errorMessage);
    } finally {
      setLoading(false);
    }
  }, [runId, sitePageId]);

  const runtimeLogReady = logs.some((log) => log.event === "runtime_log_ready");

  const loadRuntimeLog = useCallback(async () => {
    setRuntimeLogLoading(true);
    setRuntimeLogError(null);
    try {
      setRuntimeLog(await api.getRuntimeLog(runId));
    } catch (error) {
      setRuntimeLogError(error instanceof Error ? error.message : "详细日志加载失败。");
    } finally {
      setRuntimeLogLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    let cancelled = false;

    const resetAndLoad = async () => {
      await Promise.resolve();
      if (cancelled) return;
      setActiveView("events");
      setRuntimeLog(null);
      setRuntimeLogError(null);
      await loadEventLogs();
    };

    void resetAndLoad();

    return () => {
      cancelled = true;
    };
  }, [loadEventLogs]);

  const showEventLogs = () => {
    setActiveView("events");
  };

  const showRuntimeLog = async () => {
    if (runtimeLog || runtimeLogError) {
      setActiveView("runtime");
      return;
    }

    if (!runtimeLogLoading) {
      await loadRuntimeLog();
      setActiveView("runtime");
    }
  };

  const refreshActiveView = () => {
    if (activeView === "runtime") {
      void loadRuntimeLog();
      return;
    }

    void loadEventLogs();
  };

  const downloadRuntimeLog = async () => {
    setRuntimeLogDownloading(true);
    try {
      const fullLog = await api.getRuntimeLog(runId, 0);
      const blob = new Blob([fullLog.content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fullLog.relativePath.split("/").pop() ?? `run-${runId}-runtime.log`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setRuntimeLogError(error instanceof Error ? error.message : "详细日志下载失败。");
    } finally {
      setRuntimeLogDownloading(false);
    }
  };

  const eventLogContent = (
    <div className="space-y-1">
      {loading && logs.length === 0 && (
        <div className="text-sm text-muted-foreground py-4 text-center animate-pulse">
          加载日志中…
        </div>
      )}

      {!loading && includeRunError && errorMessage && (
        <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/20 text-sm text-destructive mb-3">
          <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">运行失败</p>
            <p className="font-mono text-xs mt-0.5 opacity-80">{errorMessage}</p>
          </div>
        </div>
      )}

      {!loading && logs.length === 0 && (!includeRunError || !errorMessage) && (
        <p className="text-sm text-muted-foreground py-4 text-center">
          该运行暂无日志记录。
        </p>
      )}

      {logs.map((log) => (
        <div
          key={log.logId}
          className={`flex flex-col gap-0.5 px-2 py-1.5 rounded text-sm ${
            log.level === "error"
              ? "bg-destructive/5 hover:bg-destructive/10"
              : "hover:bg-muted/50"
          }`}
        >
          <div className="flex items-start gap-2">
            <LevelIcon level={log.level} />
            <span className="text-muted-foreground text-xs font-mono shrink-0 mt-0.5 w-16">
              {formatTime(log.createdAt)}
            </span>
            <Badge
              variant={eventColor(log.event) as "default" | "secondary" | "destructive" | "outline"}
              className="text-[10px] px-1.5 py-0 h-4 shrink-0"
            >
              {log.event}
            </Badge>
            <span className={`flex-1 break-all ${log.level === "error" ? "text-destructive" : ""}`}>
              {log.message}
            </span>
          </div>
          {log.url && (
            <p className="pl-5 text-xs text-muted-foreground font-mono truncate">{log.url}</p>
          )}
          <MetaDetail meta={log.meta} />
        </div>
      ))}
    </div>
  );

  const runtimeLogContent = (
    <div className="rounded border bg-muted/30 font-mono text-xs">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5 text-muted-foreground">
        <span className="truncate">{runtimeLog?.relativePath ?? `runs/${runId}/runtime.log`}</span>
        {runtimeLog?.truncated && <span className="shrink-0">仅显示末尾 500 行</span>}
      </div>
      {runtimeLogLoading && (
        <div className="py-4 text-center text-sm text-muted-foreground animate-pulse">
          加载详细日志中…
        </div>
      )}
      {runtimeLogError && (
        <p className="px-3 py-2 text-destructive">{runtimeLogError}</p>
      )}
      {!runtimeLogError && (
        <pre className="whitespace-pre-wrap px-3 py-2">
          {runtimeLog?.content ?? "日志文件暂无内容。"}
        </pre>
      )}
    </div>
  );

  const content = activeView === "runtime" ? runtimeLogContent : eventLogContent;

  if (inline) return eventLogContent;

  const refreshing = activeView === "runtime" ? runtimeLogLoading : loading;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ScrollText className="w-4 h-4" />
            运行日志 — Run #{runId}
          </CardTitle>
          <div className="flex items-center gap-1.5">
            <div className="inline-flex rounded-md border bg-background p-0.5">
              <Button
                type="button"
                variant={activeView === "events" ? "secondary" : "ghost"}
                size="sm"
                onClick={showEventLogs}
                className="h-7 gap-1.5 px-2"
              >
                <ScrollText className="w-3.5 h-3.5" />
                事件日志
              </Button>
              <Button
                type="button"
                variant={activeView === "runtime" ? "secondary" : "ghost"}
                size="sm"
                onClick={showRuntimeLog}
                disabled={!runtimeLogReady || runtimeLogLoading}
                className="h-7 gap-1.5 px-2"
              >
                <FileText className={`w-3.5 h-3.5 ${runtimeLogLoading && activeView !== "runtime" ? "animate-pulse" : ""}`} />
                详细日志
              </Button>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={refreshActiveView}
              disabled={refreshing}
              className="h-8 w-8 p-0"
              aria-label="刷新日志"
              title="刷新日志"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={downloadRuntimeLog}
              disabled={!runtimeLogReady || runtimeLogDownloading}
              className="h-8 w-8 p-0"
              aria-label="下载详细日志"
              title="下载详细日志"
            >
              <Download className={`w-3.5 h-3.5 ${runtimeLogDownloading ? "animate-pulse" : ""}`} />
            </Button>
          </div>
        </div>
        <CardDescription>
          {activeView === "runtime"
            ? "runtime.log 详细输出"
            : logs.length > 0
            ? `共 ${logs.length} 条事件记录`
            : "结构化事件日志，包含每次页面处理和 artifact 生成的结果。"}
        </CardDescription>
      </CardHeader>
      <CardContent className="max-h-[520px] overflow-y-auto font-mono text-xs">
        {content}
      </CardContent>
    </Card>
  );
}
