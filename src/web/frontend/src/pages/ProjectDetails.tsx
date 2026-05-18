import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Globe, ChevronRight, Download, Loader2 } from "lucide-react";
import { motion } from "framer-motion";
import { ProjectLabelDefinitions } from "./ProjectLabelDefinitions";
import type { ProjectExportArtifact } from "@/lib/api";

function toPathSegment(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || name.trim();
}

export function ProjectDetails() {
  const { projectId } = useParams();
  const [sites, setSites] = useState<any[]>([]);
  const [projectSlug, setProjectSlug] = useState("");
  const [projectName, setProjectName] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [selectedExportSiteIds, setSelectedExportSiteIds] = useState<Set<number>>(new Set());
  const [selectedExportArtifacts, setSelectedExportArtifacts] = useState<Set<ProjectExportArtifact>>(
    new Set(["base", "markdown", "screenshot"]),
  );
  const [formData, setFormData] = useState({ name: "", baseUrl: "", storageRoot: "" });
  const storageRootEdited = useRef(false);

  const loadSites = () => {
    if (projectId) {
      api.getSites(Number(projectId)).then(data => {
        const nextSites = data.items || [];
        setSites(nextSites);
        setSelectedExportSiteIds(new Set(nextSites.map((site: any) => site.siteId)));
      });
    }
  };

  useEffect(() => {
    loadSites();
    api.getProjects().then((data: any) => {
      const project = (data.items || []).find((p: any) => p.projectId === Number(projectId));
      if (project) {
        setProjectSlug(project.projectSlug);
        setProjectName(project.projectName);
      }
    });
  }, [projectId]);

  const handleCreate = async () => {
    if (!formData.name || !formData.baseUrl || !formData.storageRoot) return;
    await api.createSite({
      projectId: Number(projectId),
      name: formData.name,
      baseUrl: formData.baseUrl,
      storageRoot: formData.storageRoot
    });
    setIsDialogOpen(false);
    setFormData({ name: "", baseUrl: "", storageRoot: "" });
    storageRootEdited.current = false;
    loadSites();
  };

  const handleExport = async () => {
    if (!projectId || isExporting) return;
    setIsExporting(true);
    setExportError("");

    try {
      const { blob, filename } = await api.exportProject(Number(projectId), {
        siteIds: [...selectedExportSiteIds],
        artifacts: [...selectedExportArtifacts],
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setIsExportDialogOpen(false);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "导出失败");
    } finally {
      setIsExporting(false);
    }
  };

  const allSitesSelected = sites.length > 0 && sites.every((site) => selectedExportSiteIds.has(site.siteId));
  const toggleExportSite = (siteId: number, checked: boolean) => {
    setSelectedExportSiteIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(siteId);
      } else {
        next.delete(siteId);
      }
      return next;
    });
  };
  const toggleExportArtifact = (artifact: ProjectExportArtifact, checked: boolean) => {
    setSelectedExportArtifacts((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(artifact);
      } else {
        next.delete(artifact);
      }
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
        <Link to="/" className="hover:text-foreground transition-colors">项目管理</Link>
        <ChevronRight className="w-4 h-4" />
        <span className="text-foreground font-medium">{projectName || "项目详情"}</span>
      </div>

      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">项目详情</h1>
          <p className="text-muted-foreground mt-1">管理该项目下的采集站点和 LLM 标签定义</p>
        </div>
        <Dialog open={isExportDialogOpen} onOpenChange={setIsExportDialogOpen}>
          <DialogTrigger asChild>
            <Button
              variant="outline"
              className="gap-2"
              disabled={isExporting || !projectId}
            >
              {isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              {isExporting ? "正在打包..." : "导出项目"}
            </Button>
          </DialogTrigger>
          <DialogContent className="w-[calc(100vw-2rem)] max-w-2xl min-w-0 overflow-hidden">
            <DialogHeader>
              <DialogTitle>导出项目</DialogTitle>
              <DialogDescription>选择要打包的站点和 artifact。artifact 全不选时只导出 Excel 页面列表。</DialogDescription>
            </DialogHeader>
            <div className="min-w-0 space-y-5 py-2">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label>站点</Label>
                  <label className="flex items-center gap-2 text-sm text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={allSitesSelected}
                      onChange={(event) => {
                        setSelectedExportSiteIds(
                          event.target.checked ? new Set(sites.map((site) => site.siteId)) : new Set(),
                        );
                      }}
                    />
                    全选
                  </label>
                </div>
                <div className="max-h-56 min-w-0 max-w-full overflow-y-auto overflow-x-hidden rounded-md border divide-y">
                  {sites.map((site) => (
                    <label key={site.siteId} className="flex min-w-0 items-start gap-3 px-3 py-2.5 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1 shrink-0"
                        checked={selectedExportSiteIds.has(site.siteId)}
                        onChange={(event) => toggleExportSite(site.siteId, event.target.checked)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block break-words font-medium text-foreground">{site.siteName}</span>
                        <span className="block break-all text-muted-foreground" title={site.baseUrl}>{site.baseUrl}</span>
                      </span>
                    </label>
                  ))}
                  {sites.length === 0 && (
                    <div className="px-3 py-6 text-center text-sm text-muted-foreground">暂无可导出的站点</div>
                  )}
                </div>
              </div>

              <div className="space-y-3">
                <Label>Artifacts</Label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {[
                    ["base", "Base 文本"],
                    ["markdown", "Markdown"],
                    ["screenshot", "截图"],
                  ].map(([artifact, label]) => (
                    <label key={artifact} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selectedExportArtifacts.has(artifact as ProjectExportArtifact)}
                        onChange={(event) => toggleExportArtifact(artifact as ProjectExportArtifact, event.target.checked)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsExportDialogOpen(false)}>取消</Button>
              <Button onClick={handleExport} disabled={isExporting || selectedExportSiteIds.size === 0}>
                {isExporting ? <Loader2 className="mr-2 w-4 h-4 animate-spin" /> : <Download className="mr-2 w-4 h-4" />}
                开始导出
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {exportError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {exportError}
        </div>
      )}

      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">站点列表</h2>
          <p className="text-sm text-muted-foreground mt-1">管理该项目下的所有采集目标站点</p>
        </div>

        <Dialog open={isDialogOpen} onOpenChange={(open) => { if (!open) storageRootEdited.current = false; setIsDialogOpen(open); }}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="w-4 h-4" />
              添加站点
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>添加新站点</DialogTitle>
            </DialogHeader>
            <div className="py-4 space-y-4">
              <div className="space-y-2">
                <Label>站点名称 (Name)</Label>
                <Input
                  placeholder="例如：官网文档"
                  value={formData.name}
                  onChange={(e) => {
                    const name = e.target.value;
                    const updates: typeof formData = { ...formData, name };
                    if (!storageRootEdited.current) {
                      const slug = projectSlug || `proj-${projectId}`;
                      updates.storageRoot = name ? `.local/${slug}/${toPathSegment(name)}` : "";
                    }
                    setFormData(updates);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label>站点地址 (Base URL)</Label>
                <Input
                  placeholder="https://example.com"
                  value={formData.baseUrl}
                  onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>本地存储路径 (Storage Root)</Label>
                <Input
                  placeholder=".local/example-docs"
                  value={formData.storageRoot}
                  onChange={(e) => {
                    storageRootEdited.current = true;
                    setFormData({ ...formData, storageRoot: e.target.value });
                  }}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsDialogOpen(false)}>取消</Button>
              <Button onClick={handleCreate}>保存配置</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {sites.map((site, i) => (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
            key={site.siteId}
          >
            <Link to={`/sites/${site.siteId}/overview`}>
              <Card className="hover:shadow-md transition-all hover:border-primary/50 group cursor-pointer h-full">
                <CardHeader>
                  <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                    <Globe className="w-5 h-5 text-blue-500" />
                  </div>
                  <CardTitle>{site.siteName}</CardTitle>
                  <CardDescription className="truncate mt-1" title={site.baseUrl}>
                    {site.baseUrl}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex gap-4 text-sm text-muted-foreground bg-muted/30 p-3 rounded-lg">
                    <div>
                      <span className="block font-medium text-foreground">{site.totalPages || 0}</span>
                      <span>已知页面</span>
                    </div>
                    <div className="w-px bg-border"></div>
                    <div>
                      <span className="block font-medium text-foreground">{site.pagesReadyForCapture || 0}</span>
                      <span>已抓取</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          </motion.div>
        ))}
        {sites.length === 0 && (
          <div className="col-span-full py-12 text-center text-muted-foreground border-2 border-dashed rounded-xl">
            该项目下暂无站点配置。
          </div>
        )}
      </div>

      {projectId && <ProjectLabelDefinitions projectId={Number(projectId)} />}
    </div>
  );
}
