import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CheckCircle2, Copy, Save } from "lucide-react";

interface SiteConfigShape {
  seedUrls: string[];
  sitemaps: string[];
  rulesBeforeBaseEq: unknown[];
  rulesBeforeStage2Eq: unknown[];
  runOptions: {
    seedMaxDepth: number;
    crawlMaxDepth: number;
  };
}

function linesToArray(value: string): string[] {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function arrayToLines(value: string[]): string {
  return value.join("\n");
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function SiteConfig({ siteId }: { siteId: number }) {
  const [config, setConfig] = useState<SiteConfigShape | null>(null);
  const [jsonDraft, setJsonDraft] = useState("");
  const [seedUrlsText, setSeedUrlsText] = useState("");
  const [sitemapsText, setSitemapsText] = useState("");
  const [rulesBeforeBaseText, setRulesBeforeBaseText] = useState("[]");
  const [rulesBeforeStage2Text, setRulesBeforeStage2Text] = useState("[]");
  const [seedMaxDepth, setSeedMaxDepth] = useState("1");
  const [crawlMaxDepth, setCrawlMaxDepth] = useState("2");
  const [message, setMessage] = useState("");
  const [sites, setSites] = useState<Array<{ siteId: number; siteName: string }>>([]);
  const [sourceSiteId, setSourceSiteId] = useState("");
  const [projectId, setProjectId] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const hydrate = (nextConfig: SiteConfigShape) => {
    setConfig(nextConfig);
    setJsonDraft(pretty(nextConfig));
    setSeedUrlsText(arrayToLines(nextConfig.seedUrls));
    setSitemapsText(arrayToLines(nextConfig.sitemaps));
    setRulesBeforeBaseText(pretty(nextConfig.rulesBeforeBaseEq));
    setRulesBeforeStage2Text(pretty(nextConfig.rulesBeforeStage2Eq));
    setSeedMaxDepth(String(nextConfig.runOptions.seedMaxDepth));
    setCrawlMaxDepth(String(nextConfig.runOptions.crawlMaxDepth));
  };

  const loadConfig = () => {
    api.getSiteConfig(siteId).then(hydrate);
    api.getSiteOverview(siteId).then((overview) => {
      setProjectId(overview.projectId);
      api.getSites(overview.projectId).then((data) => {
        setSites((data.items || []).filter((site: { siteId: number }) => site.siteId !== siteId));
      });
    });
  };

  useEffect(() => {
    loadConfig();
  }, [siteId]);

  const buildFormConfig = (): SiteConfigShape => ({
    seedUrls: linesToArray(seedUrlsText),
    sitemaps: linesToArray(sitemapsText),
    rulesBeforeBaseEq: JSON.parse(rulesBeforeBaseText),
    rulesBeforeStage2Eq: JSON.parse(rulesBeforeStage2Text),
    runOptions: {
      seedMaxDepth: Number(seedMaxDepth),
      crawlMaxDepth: Number(crawlMaxDepth),
    },
  });

  const saveConfig = async (nextConfig: SiteConfigShape) => {
    setIsSaving(true);
    setMessage("");
    try {
      const response = await api.updateSiteConfig(siteId, nextConfig);
      hydrate(response.config);
      setMessage("配置已保存，并通过后端校验。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败。");
    } finally {
      setIsSaving(false);
    }
  };

  const saveForm = async () => {
    await saveConfig(buildFormConfig());
  };

  const saveJson = async () => {
    await saveConfig(JSON.parse(jsonDraft));
  };

  const cloneConfig = async () => {
    if (!sourceSiteId) return;
    setIsSaving(true);
    try {
      const response = await api.cloneSiteConfig(siteId, Number(sourceSiteId));
      hydrate(response.config);
      setMessage("已从目标站点克隆配置。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "克隆失败。");
    } finally {
      setIsSaving(false);
    }
  };

  if (!config) {
    return <div className="animate-pulse p-8 text-muted-foreground">加载配置中...</div>;
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>规则配置</CardTitle>
          <CardDescription>
            表单模式覆盖常用配置，JSON 模式保留完整逃生口；保存时统一走后端 SiteConfig 校验。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-[1fr_auto]">
            <select className="h-10 rounded-md border bg-background px-3 text-sm" value={sourceSiteId} onChange={(event) => setSourceSiteId(event.target.value)} disabled={!projectId || sites.length === 0}>
              <option value="">从同项目站点克隆配置</option>
              {sites.map((site) => <option key={site.siteId} value={site.siteId}>{site.siteName}</option>)}
            </select>
            <Button variant="outline" className="gap-2" disabled={!sourceSiteId || isSaving} onClick={cloneConfig}>
              <Copy className="w-4 h-4" />
              克隆配置
            </Button>
          </div>
          {message && (
            <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <CheckCircle2 className="w-4 h-4" />
              {message}
            </div>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="form">
        <TabsList>
          <TabsTrigger value="form">表单模式</TabsTrigger>
          <TabsTrigger value="json">JSON 高级模式</TabsTrigger>
        </TabsList>

        <TabsContent value="form" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>入口与深度</CardTitle>
              <CardDescription>每行一个 URL；seed 只用于摸底，crawl 用于正式递归深度。</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <Label>Seed URLs</Label>
                <textarea className="min-h-32 w-full rounded-md border bg-background p-3 text-sm" value={seedUrlsText} onChange={(event) => setSeedUrlsText(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Sitemaps</Label>
                <textarea className="min-h-32 w-full rounded-md border bg-background p-3 text-sm" value={sitemapsText} onChange={(event) => setSitemapsText(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Seed Max Depth</Label>
                <Input type="number" min="0" value={seedMaxDepth} onChange={(event) => setSeedMaxDepth(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Crawl Max Depth</Label>
                <Input type="number" min="0" value={crawlMaxDepth} onChange={(event) => setCrawlMaxDepth(event.target.value)} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>规则 JSON 片段</CardTitle>
              <CardDescription>规则结构仍保持架构文档里的 `rulesBeforeBaseEq` 与 `rulesBeforeStage2Eq`，方便迁移和 CLI 共用。</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <Label>rulesBeforeBaseEq</Label>
                <textarea className="min-h-72 w-full rounded-md border bg-muted/20 p-3 font-mono text-xs" value={rulesBeforeBaseText} onChange={(event) => setRulesBeforeBaseText(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>rulesBeforeStage2Eq</Label>
                <textarea className="min-h-72 w-full rounded-md border bg-muted/20 p-3 font-mono text-xs" value={rulesBeforeStage2Text} onChange={(event) => setRulesBeforeStage2Text(event.target.value)} />
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button className="gap-2" onClick={saveForm} disabled={isSaving}>
              <Save className="w-4 h-4" />
              保存表单配置
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="json">
          <Card>
            <CardHeader>
              <CardTitle>完整 SiteConfig JSON</CardTitle>
              <CardDescription>适合粘贴外部配置、批量编辑规则或精确调整字段。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <textarea className="h-[560px] w-full rounded-md border bg-muted/20 p-4 font-mono text-xs" value={jsonDraft} onChange={(event) => setJsonDraft(event.target.value)} />
              <div className="flex justify-end">
                <Button className="gap-2" onClick={saveJson} disabled={isSaving}>
                  <Save className="w-4 h-4" />
                  保存 JSON 配置
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
