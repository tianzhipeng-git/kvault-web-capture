import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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

function renderTextTree(children: PathTreeNode[], prefix = ""): string[] {
  return children.flatMap((node, index) => {
    const isLast = index === children.length - 1;
    const connector = isLast ? "└──" : "├──";
    const childPrefix = `${prefix}${isLast ? "    " : "│   "}`;

    return [
      `${prefix}${connector} ${node.name}`,
      ...renderTextTree(node.children, childPrefix),
    ];
  });
}

function normalizeDomainFilter(input: string): string {
  const value = input.trim().toLowerCase().replace(/^\.+/, "");

  if (!value) {
    return "";
  }

  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.hostname.replace(/^\.+/, "");
  } catch {
    return value.split("/")[0]?.split(":")[0]?.replace(/\.+$/, "") ?? value;
  }
}

function cloneNode(node: PathTreeNode): PathTreeNode {
  return {
    ...node,
    children: node.children.map(cloneNode),
  };
}

function filterPathTreeByDomain(pathTree: PathTreeResponse, domain: string): PathTreeResponse {
  const normalizedDomain = normalizeDomainFilter(domain);

  if (!normalizedDomain) {
    return pathTree;
  }

  const domainParts = normalizedDomain.split(".").filter(Boolean).reverse();
  let current: PathTreeNode | undefined = pathTree.root;
  const ancestors: PathTreeNode[] = [];

  for (const part of domainParts) {
    current = current?.children.find((node) => node.kind === "domain" && node.name.toLowerCase() === part);

    if (!current) {
      const emptyRoot = { ...pathTree.root, pageCount: 0, terminalCount: 0, children: [] };

      return {
        ...pathTree,
        totalUrls: 0,
        root: emptyRoot,
        text: "",
      };
    }

    ancestors.push(current);
  }

  let child = cloneNode(ancestors[ancestors.length - 1]);

  for (let index = ancestors.length - 2; index >= 0; index -= 1) {
    child = {
      ...ancestors[index],
      pageCount: child.pageCount,
      terminalCount: 0,
      children: [child],
    };
  }

  const filteredRoot = {
    ...pathTree.root,
    pageCount: child.pageCount,
    terminalCount: 0,
    children: [child],
  };

  return {
    ...pathTree,
    totalUrls: child.pageCount,
    root: filteredRoot,
    text: renderTextTree(filteredRoot.children).join("\n"),
  };
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
  const [domainFilter, setDomainFilter] = useState("");
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

  const visiblePathTree = useMemo(
    () => pathTree ? filterPathTreeByDomain(pathTree, domainFilter) : null,
    [domainFilter, pathTree],
  );
  const jsonContent = useMemo(
    () => visiblePathTree ? JSON.stringify(visiblePathTree, null, 2) : "",
    [visiblePathTree],
  );
  const expandableNodeIds = useMemo(
    () => visiblePathTree ? collectExpandableNodeIds(visiblePathTree.root.children) : [],
    [visiblePathTree],
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
              onClick={() => downloadText(`site-${siteId}-path-tree.txt`, visiblePathTree?.text ?? "", "text/plain;charset=utf-8")}
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
              <div className="max-w-md space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor={`path-tree-domain-${siteId}`}>
                  域名筛选
                </label>
                <Input
                  id={`path-tree-domain-${siteId}`}
                  value={domainFilter}
                  onChange={(event) => setDomainFilter(event.target.value)}
                  placeholder="example.com"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">显示 URL {visiblePathTree?.totalUrls ?? 0}</Badge>
                {domainFilter.trim() && <Badge variant="outline">全部 URL {pathTree.totalUrls}</Badge>}
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
              {(visiblePathTree?.root.children.length ?? 0) > 0 ? (
                <div className="max-h-[460px] overflow-auto rounded-md border bg-muted/20 p-3">
                  <PathTreeBranch nodes={visiblePathTree?.root.children ?? []} expandedIds={expandedIds} onToggle={toggleNode} />
                </div>
              ) : (
                <div className="rounded-md border p-4 text-sm text-muted-foreground">
                  {domainFilter.trim() ? "这个域名下暂无已知页面。" : "暂无已知页面。"}
                </div>
              )}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
