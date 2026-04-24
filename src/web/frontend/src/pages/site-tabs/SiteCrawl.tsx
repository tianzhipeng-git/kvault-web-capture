import { useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Play, RefreshCw, Database } from "lucide-react";

export function SiteCrawl({ siteId }: { siteId: number }) {
  const [isStarting, setIsStarting] = useState(false);

  const startCrawl = async () => {
    setIsStarting(true);
    try {
      await api.startCrawlRun(siteId, { updatePolicy: "skip_existing" });
      alert("正式采集任务已启动！");
    } catch (e: any) {
      alert("启动失败: " + e.message);
    }
    setIsStarting(false);
  };

  return (
    <Card className="border-2 border-primary/20 shadow-md">
      <CardContent className="p-8">
        <div className="flex flex-col items-center text-center space-y-6">
          <div className="w-16 h-16 bg-green-500/10 rounded-full flex items-center justify-center">
            <Database className="w-8 h-8 text-green-500" />
          </div>
          <div className="max-w-md">
            <h3 className="text-2xl font-bold mb-2">正式采集 (Crawl Run)</h3>
            <p className="text-muted-foreground mb-6">
              规则已就绪。系统将开始全量深度抓取，生成 Markdown、截图等最终产物，并应用自动重试和并发控制。
            </p>
            <Button size="lg" className="w-full gap-2 text-lg h-12 bg-green-600 hover:bg-green-700 text-white" onClick={startCrawl} disabled={isStarting}>
              {isStarting ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Play className="w-5 h-5" />}
              执行正式采集
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
