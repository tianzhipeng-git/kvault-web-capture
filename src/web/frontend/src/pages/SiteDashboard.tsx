import { useEffect, useState } from "react";
import { useParams, Link, Routes, Route, useLocation, useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChevronRight, Activity, FileText, Settings as SettingsIcon, Play, Database } from "lucide-react";
import { SiteOverview } from "./site-tabs/SiteOverview";
import { SiteConfig } from "./site-tabs/SiteConfig";
import { SitePages } from "./site-tabs/SitePages";
import { SiteSeed } from "./site-tabs/SiteSeed";
import { SiteCrawl } from "./site-tabs/SiteCrawl";

export function SiteDashboard() {
  const { siteId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [site, setSite] = useState<any>(null);

  const currentTab = location.pathname.split("/").pop() || "overview";

  useEffect(() => {
    if (siteId) {
      api.getSiteOverview(Number(siteId)).then(setSite);
    }
  }, [siteId]);

  if (!site) return <div className="animate-pulse flex p-8">加载中...</div>;

  const handleTabChange = (val: string) => {
    navigate(`/sites/${siteId}/${val}`);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
        <Link to="/" className="hover:text-foreground transition-colors">项目管理</Link>
        <ChevronRight className="w-4 h-4" />
        <Link to={`/projects/${site.projectId}`} className="hover:text-foreground transition-colors">{site.projectName}</Link>
        <ChevronRight className="w-4 h-4" />
        <span className="text-foreground font-medium">{site.siteName}</span>
      </div>

      <Tabs value={currentTab} onValueChange={handleTabChange} className="w-full">
        <TabsList className="grid grid-cols-5 w-[750px] mb-8">
          <TabsTrigger value="overview" className="gap-2"><Activity className="w-4 h-4" /> 站点概览</TabsTrigger>
          <TabsTrigger value="config" className="gap-2"><SettingsIcon className="w-4 h-4" /> 规则配置</TabsTrigger>
          <TabsTrigger value="seed" className="gap-2"><Play className="w-4 h-4" /> 初步摸底</TabsTrigger>
          <TabsTrigger value="crawl" className="gap-2"><Database className="w-4 h-4" /> 正式采集</TabsTrigger>
          <TabsTrigger value="pages" className="gap-2"><FileText className="w-4 h-4" /> 页面清单</TabsTrigger>
        </TabsList>

        <div className="mt-4">
          <Routes>
            <Route path="overview" element={<SiteOverview site={site} siteId={Number(siteId)} />} />
            <Route path="config" element={<SiteConfig siteId={Number(siteId)} />} />
            <Route path="seed" element={<SiteSeed siteId={Number(siteId)} />} />
            <Route path="crawl" element={<SiteCrawl siteId={Number(siteId)} />} />
            <Route path="pages" element={<SitePages siteId={Number(siteId)} />} />
          </Routes>
        </div>
      </Tabs>
    </div>
  );
}
