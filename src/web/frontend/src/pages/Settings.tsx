import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Loader2, Save } from "lucide-react";

export function Settings() {
  const [projects, setProjects] = useState<any[]>([]);
  const [sites, setSites] = useState<any[]>([]);
  const [projectId, setProjectId] = useState("");
  const [siteId, setSiteId] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      api.getProjects(),
      api.getDefaultSite(),
    ]).then(async ([projectData, defaultSiteData]) => {
      const nextProjects = projectData.items || [];
      const defaultSite = defaultSiteData.defaultSite;
      const nextProjectId = defaultSite?.projectId ?? nextProjects[0]?.projectId ?? "";
      setProjects(nextProjects);
      setProjectId(String(nextProjectId));
      setSiteId(defaultSite ? String(defaultSite.siteId) : "");

      if (nextProjectId) {
        const siteData = await api.getSites(Number(nextProjectId));
        setSites(siteData.items || []);
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">系统设置</h1>
        <p className="text-muted-foreground mt-1">配置简易提交入口使用的默认站点</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>默认站点</CardTitle>
          <CardDescription>快捷提交 URL 时，会在这个站点下发起一次深度为 0 的正式采集。</CardDescription>
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
    </div>
  );
}
