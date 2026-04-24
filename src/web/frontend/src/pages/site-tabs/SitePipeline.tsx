import { useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Play, CheckCircle2, ArrowRight, Eye, RefreshCw, Database } from "lucide-react";
import { motion } from "framer-motion";

const steps = [
  { id: 1, title: "1. 规则配置", desc: "定义抓取范围和提取要求" },
  { id: 2, title: "2. 初步摸底", desc: "仅收集页面，不下载重度内容" },
  { id: 3, title: "3. 人工复核", desc: "检查未匹配规则的未知页面" },
  { id: 4, title: "4. 正式采集", desc: "全量抓取所有目标产物" },
];

export function SitePipeline({ siteId }: { siteId: number }) {
  const [activeStep, setActiveStep] = useState(2); // Example static active step for UI purpose
  const [isStarting, setIsStarting] = useState(false);

  const startSeed = async () => {
    setIsStarting(true);
    try {
      await api.startSeedRun(siteId);
      alert("初步摸底任务已启动！");
      setActiveStep(3);
    } catch (e: any) {
      alert("启动失败: " + e.message);
    }
    setIsStarting(false);
  };

  const startCrawl = async () => {
    setIsStarting(true);
    try {
      await api.startCrawlRun(siteId, { updatePolicy: "skip_existing" });
      alert("正式采集任务已启动！");
      setActiveStep(5);
    } catch (e: any) {
      alert("启动失败: " + e.message);
    }
    setIsStarting(false);
  };

  return (
    <div className="space-y-8">
      {/* Pipeline Visualizer */}
      <div className="flex items-center justify-between mb-12 relative">
        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-full h-1 bg-muted -z-10 rounded-full"></div>
        <div 
          className="absolute left-0 top-1/2 -translate-y-1/2 h-1 bg-primary -z-10 transition-all duration-500 rounded-full"
          style={{ width: `${((activeStep - 1) / (steps.length - 1)) * 100}%` }}
        ></div>
        
        {steps.map((step) => {
          const isActive = step.id === activeStep;
          const isDone = step.id < activeStep;
          return (
            <div key={step.id} className="flex flex-col items-center gap-3 bg-background px-4">
              <div className={`w-12 h-12 rounded-full flex items-center justify-center border-4 transition-colors ${
                isActive ? "border-primary bg-primary text-primary-foreground shadow-lg shadow-primary/30" : 
                isDone ? "border-primary bg-background text-primary" : "border-muted bg-background text-muted-foreground"
              }`}>
                {isDone ? <CheckCircle2 className="w-6 h-6" /> : <span className="font-bold text-lg">{step.id}</span>}
              </div>
              <div className="text-center">
                <div className={`font-semibold ${isActive ? "text-primary" : isDone ? "text-foreground" : "text-muted-foreground"}`}>
                  {step.title}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Current Step Actions */}
      <Card className="border-2 border-primary/20 shadow-md">
        <CardContent className="p-8">
          {activeStep === 2 && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center text-center space-y-6">
              <div className="w-16 h-16 bg-blue-500/10 rounded-full flex items-center justify-center">
                <Play className="w-8 h-8 text-blue-500 ml-1" />
              </div>
              <div className="max-w-md">
                <h3 className="text-2xl font-bold mb-2">执行初步摸底 (Seed Run)</h3>
                <p className="text-muted-foreground mb-6">
                  系统将从入口地址出发，探索发现全站的链接结构，并提取基础信息进行分类打标。此过程不会触发耗时的 Markdown 或截图任务。
                </p>
                <Button size="lg" className="w-full gap-2 text-lg h-12" onClick={startSeed} disabled={isStarting}>
                  {isStarting ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Play className="w-5 h-5" />}
                  启动初步摸底
                </Button>
              </div>
            </motion.div>
          )}

          {activeStep === 3 && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center text-center space-y-6">
              <div className="w-16 h-16 bg-orange-500/10 rounded-full flex items-center justify-center">
                <Eye className="w-8 h-8 text-orange-500" />
              </div>
              <div className="max-w-md">
                <h3 className="text-2xl font-bold mb-2">人工复核与规则调优</h3>
                <p className="text-muted-foreground mb-6">
                  摸底已完成。当前可能有部分页面无法被现有规则匹配，它们处于【待复核】状态。您可以去“页面清单”中查看并修改规则。
                </p>
                <div className="flex gap-4 w-full">
                  <Button size="lg" variant="outline" className="flex-1" onClick={() => setActiveStep(2)}>
                    重新摸底
                  </Button>
                  <Button size="lg" className="flex-1 gap-2" onClick={() => setActiveStep(4)}>
                    规则已确认 <ArrowRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </motion.div>
          )}

          {activeStep === 4 && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center text-center space-y-6">
              <div className="w-16 h-16 bg-green-500/10 rounded-full flex items-center justify-center">
                <Database className="w-8 h-8 text-green-500" />
              </div>
              <div className="max-w-md">
                <h3 className="text-2xl font-bold mb-2">启动正式采集 (Crawl Run)</h3>
                <p className="text-muted-foreground mb-6">
                  规则已就绪。系统将开始全量深度抓取，生成 Markdown、截图等最终产物，并应用自动重试和并发控制。
                </p>
                <Button size="lg" className="w-full gap-2 text-lg h-12 bg-green-600 hover:bg-green-700 text-white" onClick={startCrawl} disabled={isStarting}>
                  {isStarting ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Play className="w-5 h-5" />}
                  执行正式采集
                </Button>
                <Button variant="link" className="mt-4" onClick={() => setActiveStep(3)}>返回上一步</Button>
              </div>
            </motion.div>
          )}

          {activeStep === 5 && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center text-center space-y-6">
              <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center">
                <CheckCircle2 className="w-8 h-8 text-primary" />
              </div>
              <div className="max-w-md">
                <h3 className="text-2xl font-bold mb-2">采集任务已下发</h3>
                <p className="text-muted-foreground mb-6">
                  您可以在“站点概览”中查看实时进度，或在“页面清单”中浏览采集到的最终产物。
                </p>
                <Button size="lg" variant="outline" className="w-full" onClick={() => setActiveStep(2)}>
                  开启新一轮迭代
                </Button>
              </div>
            </motion.div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
