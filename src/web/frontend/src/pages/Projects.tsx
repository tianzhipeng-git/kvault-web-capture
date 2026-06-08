import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Folder, Loader2, Send } from "lucide-react";
import { motion } from "framer-motion";

export function Projects() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<any[]>([]);
  const [defaultSite, setDefaultSite] = useState<any>(null);
  const [quickUrl, setQuickUrl] = useState("");
  const [isSubmittingQuickUrl, setIsSubmittingQuickUrl] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const loadProjects = () => {
    api.getProjects().then(data => setProjects(data.items || []));
    api.getDefaultSite().then(data => setDefaultSite(data.defaultSite));
  };

  useEffect(() => {
    loadProjects();
  }, []);

  const handleCreate = async () => {
    if (!newProjectName) return;
    await api.createProject(newProjectName);
    setIsDialogOpen(false);
    setNewProjectName("");
    loadProjects();
  };

  const submitQuickUrl = async () => {
    if (!quickUrl.trim()) return;
    setIsSubmittingQuickUrl(true);
    try {
      const result = await api.submitSimpleCapture(quickUrl.trim());
      setQuickUrl("");
      toast.success(`已提交 Run #${result.runId}。`);
      navigate(`/sites/${result.siteId}/crawl?runId=${result.runId}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "提交失败。");
    } finally {
      setIsSubmittingQuickUrl(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">项目管理</h1>
          <p className="text-muted-foreground mt-1">管理您所有的爬虫项目与业务线</p>
        </div>
        
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="w-4 h-4" />
              新建项目
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>新建项目</DialogTitle>
            </DialogHeader>
            <div className="py-4 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">项目名称</Label>
                <Input
                  id="name"
                  placeholder="例如：电商竞品分析"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsDialogOpen(false)}>取消</Button>
              <Button onClick={handleCreate}>确认创建</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader className="space-y-4">
          <div>
            <CardTitle>简易提交</CardTitle>
            <CardDescription>
              {defaultSite
                ? `默认站点：${defaultSite.siteName} · ${defaultSite.baseUrl}`
                : "请先在系统设置里配置默认站点。"}
            </CardDescription>
          </div>
          <div className="grid gap-3 md:grid-cols-[1fr_auto]">
            <Input
              placeholder="粘贴要采集的 URL"
              value={quickUrl}
              onChange={(event) => setQuickUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  submitQuickUrl();
                }
              }}
              disabled={!defaultSite || isSubmittingQuickUrl}
            />
            <Button className="gap-2" onClick={submitQuickUrl} disabled={!defaultSite || !quickUrl.trim() || isSubmittingQuickUrl}>
              {isSubmittingQuickUrl ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              提交
            </Button>
          </div>
        </CardHeader>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {projects.map((project, i) => (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
            key={project.projectId}
          >
            <Link to={`/projects/${project.projectId}`}>
              <Card className="hover:shadow-md transition-all hover:border-primary/50 group cursor-pointer h-full">
                <CardHeader>
                  <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                    <Folder className="w-5 h-5 text-primary" />
                  </div>
                  <CardTitle>{project.projectName}</CardTitle>
                  <CardDescription className="line-clamp-2 mt-2">
                    Slug: {project.projectSlug}
                  </CardDescription>
                </CardHeader>
              </Card>
            </Link>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
