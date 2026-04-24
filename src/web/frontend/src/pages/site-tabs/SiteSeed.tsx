import { useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Play, RefreshCw } from "lucide-react";

export function SiteSeed({ siteId }: { siteId: number }) {
  const [isStarting, setIsStarting] = useState(false);

  const startSeed = async () => {
    setIsStarting(true);
    try {
      await api.startSeedRun(siteId);
      alert("初步摸底任务已启动！");
    } catch (e: any) {
      alert("启动失败: " + e.message);
    }
    setIsStarting(false);
  };

  return (
    <Card className="border-2 border-primary/20 shadow-md">
      <CardContent className="p-8">
        <div className="flex flex-col items-center text-center space-y-6">
          <div className="w-16 h-16 bg-blue-500/10 rounded-full flex items-center justify-center">
            <Play className="w-8 h-8 text-blue-500 ml-1" />
          </div>
          <div className="max-w-md">
            <h3 className="text-2xl font-bold mb-2">初步摸底 (Seed Run)</h3>
            <p className="text-muted-foreground mb-6">
              系统将从入口地址出发，探索发现全站的链接结构，并提取基础信息进行分类打标。此过程不会触发耗时的 Markdown 或截图任务。
            </p>
            <Button size="lg" className="w-full gap-2 text-lg h-12" onClick={startSeed} disabled={isStarting}>
              {isStarting ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Play className="w-5 h-5" />}
              启动初步摸底
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
