import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type PathTreeNode, type PathTreeResponse } from "@/lib/api";
import { ChevronDown, ChevronRight, Download, Folder, FolderTree, Globe2 } from "lucide-react";

function downloadText(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function collectExpandableNodeIds(nodes: PathTreeNode[], parentId = ""): string[] {
  return nodes.flatMap((node) => {
    const nodeKey = `${node.kind}:${node.name}`;
    const nodeId = parentId ? `${parentId}/${nodeKey}` : nodeKey;

    if (node.children.length === 0) {
      return [];
    }

    return [nodeId, ...collectExpandableNodeIds(node.children, nodeId)];
  });
}

function PathTreeKindIcon({ kind }: { kind: PathTreeNode["kind"] }) {
  if (kind === "domain") {
    return <Globe2 className="h-4 w-4 text-blue-600" aria-label="domain" />;
  }

  return <Folder className="h-4 w-4 text-amber-600" aria-label="path" />;
}

function PathTreeBranch({
  nodes,
  expandedIds,
  onToggle,
  depth = 0,
  parentId = "",
}: {
  nodes: PathTreeNode[];
  expandedIds: Set<string>;
  onToggle: (nodeId: string) => void;
  depth?: number;
  parentId?: string;
}) {
  return (
    <ul className={depth === 0 ? "space-y-1" : "ml-5 mt-1 space-y-1 border-l pl-4"}>
      {nodes.map((node) => {
        const nodeKey = `${node.kind}:${node.name}`;
        const nodeId = parentId ? `${parentId}/${nodeKey}` : nodeKey;
        const isExpandable = node.children.length > 0;
        const isExpanded = expandedIds.has(nodeId);

        return (
          <li key={nodeId} className="text-sm">
            <div className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-muted/60">
              {isExpandable ? (
                <button
                  type="button"
                  className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-background"
                  onClick={() => onToggle(nodeId)}
                  aria-label={isExpanded ? "折叠目录" : "展开目录"}
                >
                  {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>
              ) : (
                <span className="h-5 w-5 shrink-0" />
              )}
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center" title={node.kind}>
                <PathTreeKindIcon kind={node.kind} />
              </span>
              <span className="break-all font-medium">{node.name}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{node.pageCount}</span>
            </div>
            {isExpandable && isExpanded && (
              <PathTreeBranch
                nodes={node.children}
                expandedIds={expandedIds}
                onToggle={onToggle}
                depth={depth + 1}
                parentId={nodeId}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function SitePathTreePanel({ siteId }: { siteId: number }) {
  const [isOpen, setIsOpen] = useState(false);
  const [pathTree, setPathTree] = useState<PathTreeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const loadPathTree = async () => {
    if (isLoading) return;

    setIsLoading(true);
    setError(null);

    try {
      const nextPathTree = await api.getSitePathTree(siteId);
      setPathTree(nextPathTree);
      setExpandedIds(new Set(collectExpandableNodeIds(nextPathTree.root.children)));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Path tree 加载失败");
    } finally {
      setIsLoading(false);
    }
  };

  const jsonContent = useMemo(
    () => pathTree ? JSON.stringify(pathTree, null, 2) : "",
    [pathTree],
  );
  const expandableNodeIds = useMemo(
    () => pathTree ? collectExpandableNodeIds(pathTree.root.children) : [],
    [pathTree],
  );

  const toggleNode = (nodeId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);

      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }

      return next;
    });
  };

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center">
            {isOpen ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
          </span>
          <div className="min-w-0 space-y-1.5">
            <CardTitle className="flex items-center gap-2"><FolderTree className="w-5 h-5" /> Path Tree</CardTitle>
            <CardDescription>按域名和 URL path 分组展示当前站点已知页面。</CardDescription>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => setIsOpen((current) => !current)}>
          {isOpen ? "收起" : "展开"}
        </Button>
      </CardHeader>
      {isOpen && (
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" disabled={isLoading} onClick={loadPathTree}>
              <FolderTree className="h-4 w-4" /> {pathTree ? "刷新" : isLoading ? "加载中" : "生成"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={!pathTree}
              onClick={() => downloadText(`site-${siteId}-path-tree.json`, jsonContent, "application/json;charset=utf-8")}
            >
              <Download className="h-4 w-4" /> JSON
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={!pathTree}
              onClick={() => downloadText(`site-${siteId}-path-tree.txt`, pathTree?.text ?? "", "text/plain;charset=utf-8")}
            >
              <Download className="h-4 w-4" /> Text
            </Button>
          </div>

          {error && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
          {!error && !pathTree && (
            <div className="rounded-md border p-4 text-sm text-muted-foreground">
              点击“生成”后分析当前站点已知页面 URL。
            </div>
          )}
          {pathTree && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">URL {pathTree.totalUrls}</Badge>
                {pathTree.skippedUrls.length > 0 && <Badge variant="outline">跳过 {pathTree.skippedUrls.length}</Badge>}
                <div className="ml-auto flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={expandableNodeIds.length === 0}
                    onClick={() => setExpandedIds(new Set())}
                  >
                    折叠所有
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={expandableNodeIds.length === 0}
                    onClick={() => setExpandedIds(new Set(expandableNodeIds))}
                  >
                    展开所有
                  </Button>
                </div>
              </div>
              {pathTree.root.children.length > 0 ? (
                <div className="max-h-[460px] overflow-auto rounded-md border bg-muted/20 p-3">
                  <PathTreeBranch nodes={pathTree.root.children} expandedIds={expandedIds} onToggle={toggleNode} />
                </div>
              ) : (
                <div className="rounded-md border p-4 text-sm text-muted-foreground">暂无已知页面。</div>
              )}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
