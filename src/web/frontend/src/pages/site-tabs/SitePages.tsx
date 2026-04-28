import { useNavigate } from "react-router-dom";
import { PageReview } from "./PageReview";

export function SitePages({ siteId }: { siteId: number }) {
  const navigate = useNavigate();

  return (
    <PageReview
      siteId={siteId}
      title="页面清单"
      description="以 site_pages 为基本单位查看全站页面、最新三类爬取状态与历史运行记录。"
      enableExport
      onRecrawlStarted={() => navigate(`/sites/${siteId}/crawl`)}
    />
  );
}
