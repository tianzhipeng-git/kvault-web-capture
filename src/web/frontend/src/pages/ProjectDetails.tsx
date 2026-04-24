import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Globe, ChevronRight } from "lucide-react";
import { motion } from "framer-motion";

function toPathSegment(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || name.trim();
}

export function ProjectDetails() {
  const { projectId } = useParams();
  const [sites, setSites] = useState<any[]>([]);
  const [projectSlug, setProjectSlug] = useState("");
  const [projectName, setProjectName] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [formData, setFormData] = useState({ name: "", baseUrl: "", storageRoot: "" });
  const storageRootEdited = useRef(false);

  const loadSites = () => {
    if (projectId) {
      api.getSites(Number(projectId)).then(data => setSites(data.items || []));
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

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
        <Link to="/" className="hover:text-foreground transition-colors">项目管理</Link>
        <ChevronRight className="w-4 h-4" />
        <span className="text-foreground font-medium">{projectName || "项目详情"}</span>
      </div>

      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">站点列表</h1>
          <p className="text-muted-foreground mt-1">管理该项目下的所有采集目标站点</p>
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
                      updates.storageRoot = name ? `./data/${slug}/${toPathSegment(name)}` : "";
                    }
                    setFormData(updates);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label>起始地址 (Base URL)</Label>
                <Input
                  placeholder="https://example.com"
                  value={formData.baseUrl}
                  onChange={(e) => setFormData({...formData, baseUrl: e.target.value})}
                />
              </div>
              <div className="space-y-2">
                <Label>本地存储路径 (Storage Root)</Label>
                <Input
                  placeholder="./data/example-docs"
                  value={formData.storageRoot}
                  onChange={(e) => {
                    storageRootEdited.current = true;
                    setFormData({...formData, storageRoot: e.target.value});
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
    </div>
  );
}
