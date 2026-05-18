import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, AlertTriangle, CheckCircle2, Compass, Settings2 } from "lucide-react";
import { SitePathTreePanel } from "./SitePathTreePanel";

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "-";
}

export function SiteOverview({ site, siteId }: { site: any; siteId: number }) {
  const cards = [
    { label: "已知页面", value: site.totalPages || 0, tone: "text-foreground" },
    { label: "已完成采集", value: site.pagesCaptured || 0, tone: "text-green-600" },
    { label: "待复核", value: site.pagesNeedReview || 0, tone: "text-orange-600" },
    { label: "规则拒绝", value: site.pagesExcluded || 0, tone: "text-red-600" },
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-4">
        {cards.map((card) => (
          <Card key={card.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{card.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className={`text-3xl font-bold ${card.tone}`}>{card.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <SitePathTreePanel siteId={siteId} />

      <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Compass className="w-5 h-5" /> 当前工作流</CardTitle>
            <CardDescription>根据现有 inventory 和 run 记录推导下一步。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {(site.workflowSteps || []).map((step: any) => (
              <div key={step.key} className="flex gap-3 rounded-lg border p-4">
                <div className="pt-0.5">
                  {step.status === "done" ? <CheckCircle2 className="w-5 h-5 text-green-600" /> : step.status === "active" ? <Activity className="w-5 h-5 text-blue-600" /> : <AlertTriangle className="w-5 h-5 text-muted-foreground" />}
                </div>
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{step.title}</span>
                    <Badge variant={step.status === "done" ? "default" : step.status === "active" ? "secondary" : "outline"}>{step.status}</Badge>
                  </div>
                  <div className="text-sm text-muted-foreground">{step.description}</div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Settings2 className="w-5 h-5" /> 配置摘要</CardTitle>
            <CardDescription>来自当前站点配置快照。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Seed URLs</span><span>{site.configSummary?.seedUrlCount ?? 0}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Sitemaps</span><span>{site.configSummary?.sitemapCount ?? 0}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">URL 前置规则</span><span>{site.configSummary?.preFilterRuleCount ?? 0}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Stage2 规则</span><span>{site.configSummary?.captureRuleCount ?? 0}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Seed 深度</span><span>{site.configSummary?.seedDepth ?? 0}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Crawl 深度</span><span>{site.configSummary?.crawlDepth ?? 0}</span></div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>最近初步摸底</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {site.latestSeedRun ? `Run #${site.latestSeedRun.runId} · ${site.latestSeedRun.statusLabel} · ${formatDate(site.latestSeedRun.startedAt)}` : "尚未执行。"}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>最近正式采集</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {site.latestCrawlRun ? `Run #${site.latestCrawlRun.runId} · ${site.latestCrawlRun.statusLabel} · ${formatDate(site.latestCrawlRun.startedAt)}` : "尚未执行。"}
          </CardContent>
        </Card>
      </div>

      {(site.ruleReviewHints || []).length > 0 && (
        <Card className="border-orange-500/30">
          <CardHeader>
            <CardTitle>复核提示</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            {site.ruleReviewHints.map((hint: string) => <div key={hint}>{hint}</div>)}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
