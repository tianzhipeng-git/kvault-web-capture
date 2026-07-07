import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Loader2, Save } from "lucide-react";

function linesToArray(value: string): string[] {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function arrayToLines(value: string[] | undefined): string {
  return (value ?? []).join("\n");
}

export function Settings() {
  const [projects, setProjects] = useState<any[]>([]);
  const [sites, setSites] = useState<any[]>([]);
  const [projectId, setProjectId] = useState("");
  const [siteId, setSiteId] = useState("");
  const [markdownSites, setMarkdownSites] = useState<any[]>([]);
  const [markdownProjectId, setMarkdownProjectId] = useState("");
  const [markdownSiteId, setMarkdownSiteId] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingMarkdown, setIsSavingMarkdown] = useState(false);
  const [stripQueryParamsText, setStripQueryParamsText] = useState("");
  const [stripQueryParamPrefixesText, setStripQueryParamPrefixesText] = useState("");
  const [isSavingUrlNormalization, setIsSavingUrlNormalization] = useState(false);

  useEffect(() => {
    Promise.all([
      api.getProjects(),
      api.getDefaultSite(),
      api.getDefaultMarkdownSite(),
      api.getSystemConfig(),
    ]).then(async ([projectData, defaultSiteData, defaultMarkdownSiteData, systemConfigData]) => {
      const nextProjects = projectData.items || [];
      const defaultSite = defaultSiteData.defaultSite;
      const defaultMarkdownSite = defaultMarkdownSiteData.defaultSite;
      const nextProjectId = defaultSite?.projectId ?? nextProjects[0]?.projectId ?? "";
      const nextMarkdownProjectId = defaultMarkdownSite?.projectId ?? nextProjects[0]?.projectId ?? "";
      setProjects(nextProjects);
      setProjectId(String(nextProjectId));
      setSiteId(defaultSite ? String(defaultSite.siteId) : "");
      setMarkdownProjectId(String(nextMarkdownProjectId));
      setMarkdownSiteId(defaultMarkdownSite ? String(defaultMarkdownSite.siteId) : "");
      setStripQueryParamsText(arrayToLines(systemConfigData.config.urlNormalization.stripQueryParams));
      setStripQueryParamPrefixesText(arrayToLines(systemConfigData.config.urlNormalization.stripQueryParamPrefixes));

      if (nextProjectId) {
        const siteData = await api.getSites(Number(nextProjectId));
        setSites(siteData.items || []);
      }
      if (nextMarkdownProjectId) {
        const siteData = await api.getSites(Number(nextMarkdownProjectId));
        setMarkdownSites(siteData.items || []);
      }
    });
  }, []);

  useEffect(() => {
    if (!projectId) {
      setSites([]);
      setSiteId("");
      return;
    }

    api.getSites(Number(projectId)).then((data) => {
      const nextSites = data.items || [];
      setSites(nextSites);
      setSiteId((current) => (
        current && nextSites.some((site: any) => String(site.siteId) === current)
          ? current
          : ""
      ));
    });
  }, [projectId]);

  useEffect(() => {
    if (!markdownProjectId) {
      setMarkdownSites([]);
      setMarkdownSiteId("");
      return;
    }

    api.getSites(Number(markdownProjectId)).then((data) => {
      const nextSites = data.items || [];
      setMarkdownSites(nextSites);
      setMarkdownSiteId((current) => (
        current && nextSites.some((site: any) => String(site.siteId) === current)
          ? current
          : ""
      ));
    });
  }, [markdownProjectId]);

  const saveDefaultSite = async () => {
    setIsSaving(true);
    try {
      await api.setDefaultSite(siteId ? Number(siteId) : null);
      toast.success(siteId ? "默认站点已更新。" : "已清空默认站点。");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败。");
    } finally {
      setIsSaving(false);
    }
  };

  const saveDefaultMarkdownSite = async () => {
    setIsSavingMarkdown(true);
    try {
      await api.setDefaultMarkdownSite(markdownSiteId ? Number(markdownSiteId) : null);
      toast.success(markdownSiteId ? "默认 Markdown 站点已更新。" : "已清空默认 Markdown 站点。");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败。");
    } finally {
      setIsSavingMarkdown(false);
    }
  };

  const saveUrlNormalization = async () => {
    setIsSavingUrlNormalization(true);
    try {
      const response = await api.updateSystemUrlNormalization({
        stripQueryParams: linesToArray(stripQueryParamsText),
        stripQueryParamPrefixes: linesToArray(stripQueryParamPrefixesText),
      });
      setStripQueryParamsText(arrayToLines(response.config.urlNormalization.stripQueryParams));
      setStripQueryParamPrefixesText(arrayToLines(response.config.urlNormalization.stripQueryParamPrefixes));
      toast.success("URL 标准化系统配置已更新。");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败。");
    } finally {
      setIsSavingUrlNormalization(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">系统设置</h1>
        <p className="text-muted-foreground mt-1">配置简易提交入口和全局 URL 标准化规则</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>默认站点</CardTitle>
          <CardDescription>快捷提交 URL 且 artifactMode 为 all 时，会在这个站点下发起一次深度为 0 的正式采集。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-[1fr_1fr_auto]">
          <div className="space-y-2">
            <Label>项目</Label>
            <select
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">未选择</option>
              {projects.map((project) => (
                <option key={project.projectId} value={project.projectId}>
                  {project.projectName}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label>站点</Label>
            <select
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={siteId}
              onChange={(event) => setSiteId(event.target.value)}
            >
              <option value="">未设置默认站点</option>
              {sites.map((site) => (
                <option key={site.siteId} value={site.siteId}>
                  {site.siteName}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <Button className="w-full gap-2" onClick={saveDefaultSite} disabled={isSaving}>
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              保存
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>默认 Markdown 站点</CardTitle>
          <CardDescription>简易 Markdown 提交和 artifactMode 为 markdown 的分步提交会使用这个站点。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-[1fr_1fr_auto]">
          <div className="space-y-2">
            <Label>项目</Label>
            <select
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={markdownProjectId}
              onChange={(event) => setMarkdownProjectId(event.target.value)}
            >
              <option value="">未选择</option>
              {projects.map((project) => (
                <option key={project.projectId} value={project.projectId}>
                  {project.projectName}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label>站点</Label>
            <select
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={markdownSiteId}
              onChange={(event) => setMarkdownSiteId(event.target.value)}
            >
              <option value="">未设置默认 Markdown 站点</option>
              {markdownSites.map((site) => (
                <option key={site.siteId} value={site.siteId}>
                  {site.siteName}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <Button className="w-full gap-2" onClick={saveDefaultMarkdownSite} disabled={isSavingMarkdown}>
              {isSavingMarkdown ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              保存
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>URL 标准化</CardTitle>
          <CardDescription>系统级规则会和站点级 urlNormalization 合并，用于页面清单去重。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-[1fr_1fr_auto]">
          <div className="space-y-2">
            <Label>去除的 Query 参数</Label>
            <textarea
              className="h-32 w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={stripQueryParamsText}
              onChange={(event) => setStripQueryParamsText(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>去除的 Query 参数前缀</Label>
            <textarea
              className="h-32 w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={stripQueryParamPrefixesText}
              onChange={(event) => setStripQueryParamPrefixesText(event.target.value)}
            />
          </div>
          <div className="flex items-end">
            <Button className="w-full gap-2" onClick={saveUrlNormalization} disabled={isSavingUrlNormalization}>
              {isSavingUrlNormalization ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              保存
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
