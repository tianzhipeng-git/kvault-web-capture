import { useState, useEffect } from "react";
import { api } from "@/lib/api";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function SitePages({ siteId }: { siteId: number }) {
  const [pages, setPages] = useState<any[]>([]);
  const [selectedPage, setSelectedPage] = useState<any>(null);

  useEffect(() => {
    api.getSitePages(siteId, { pageSize: 50 }).then(data => setPages(data.rows || []));
  }, [siteId]);

  return (
    <div className="space-y-4 bg-card rounded-xl border p-4 shadow-sm">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold">页面清单</h2>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>网址 (URL)</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>发现来源</TableHead>
            <TableHead>最近更新</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pages.map((p) => (
            <TableRow key={p.sitePageId} className="cursor-pointer hover:bg-muted/50" onClick={() => setSelectedPage(p)}>
              <TableCell className="font-medium truncate max-w-[300px]" title={p.url}>
                <div className="font-medium">{p.title}</div>
                <div className="text-xs text-muted-foreground truncate">{p.url}</div>
              </TableCell>
              <TableCell>
                <Badge variant={
                  p.businessStatus === '不采集' ? 'destructive' :
                  p.needsReview ? 'secondary' : 'default'
                }>
                  {p.businessStatus}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">{p.discoverySource}</TableCell>
              <TableCell className="text-muted-foreground">
                {p.latestHandledAt ? new Date(p.latestHandledAt).toLocaleString() : '-'}
              </TableCell>
            </TableRow>
          ))}
          {pages.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">暂无页面记录</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <Dialog open={!!selectedPage} onOpenChange={(open) => !open && setSelectedPage(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>页面详情</DialogTitle>
          </DialogHeader>
          {selectedPage && (
            <div className="space-y-4 text-sm mt-4">
              <div className="grid grid-cols-4 gap-2 bg-muted/30 p-3 rounded-lg">
                <div className="font-semibold text-muted-foreground">页面标题</div>
                <div className="col-span-3">{selectedPage.title}</div>
                <div className="font-semibold text-muted-foreground">URL</div>
                <div className="col-span-3 break-all">{selectedPage.url}</div>
                <div className="font-semibold text-muted-foreground">发现来源</div>
                <div className="col-span-3">{selectedPage.discoverySource}</div>
                <div className="font-semibold text-muted-foreground">业务状态</div>
                <div className="col-span-3"><Badge>{selectedPage.businessStatus}</Badge></div>
                <div className="font-semibold text-muted-foreground">最新结果</div>
                <div className="col-span-3">{selectedPage.latestOutcome}</div>
                {selectedPage.pendingReasonLabel && <>
                  <div className="font-semibold text-muted-foreground">待处理原因</div>
                  <div className="col-span-3">{selectedPage.pendingReasonLabel}</div>
                </>}
                {selectedPage.tags?.length > 0 && <>
                  <div className="font-semibold text-muted-foreground">标签</div>
                  <div className="col-span-3 flex gap-1 flex-wrap">
                    {selectedPage.tags.map((tag: string) => <Badge key={tag} variant="outline">{tag}</Badge>)}
                  </div>
                </>}
              </div>

              <div className="border rounded-md p-4 bg-muted/10 text-muted-foreground">
                <p>采集摘要: {selectedPage.captureSummary || '暂无'}</p>
                <p>最近处理时间: {selectedPage.latestHandledAt ? new Date(selectedPage.latestHandledAt).toLocaleString() : '未执行'}</p>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
