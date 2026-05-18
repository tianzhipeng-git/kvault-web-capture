export type PathTreeNodeKind = 'root' | 'domain' | 'path';

export interface PathTreeNode {
  name: string;
  kind: PathTreeNodeKind;
  pageCount: number;
  terminalCount: number;
  children: PathTreeNode[];
}

export interface PathTreeResult {
  totalUrls: number;
  skippedUrls: string[];
  root: PathTreeNode;
  text: string;
}

interface MutablePathTreeNode {
  name: string;
  kind: PathTreeNodeKind;
  pageCount: number;
  terminalCount: number;
  children: Map<string, MutablePathTreeNode>;
}

interface UrlTreePart {
  name: string;
  kind: Exclude<PathTreeNodeKind, 'root'>;
}

function createNode(name: string, kind: PathTreeNodeKind): MutablePathTreeNode {
  return {
    name,
    kind,
    pageCount: 0,
    terminalCount: 0,
    children: new Map(),
  };
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function getUrlParts(input: string): UrlTreePart[] {
  const url = new URL(input);
  const hostnameParts = url.hostname
    .toLowerCase()
    .split('.')
    .filter(Boolean)
    .reverse()
    .map((name) => ({ name, kind: 'domain' as const }));
  const pathParts = url.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => ({ name: decodePathSegment(segment), kind: 'path' as const }));

  return [...hostnameParts, ...pathParts];
}

function getNodeKey(part: UrlTreePart): string {
  return `${part.kind}\u0000${part.name}`;
}

function insertUrl(root: MutablePathTreeNode, parts: UrlTreePart[]): void {
  root.pageCount += 1;
  let current = root;

  for (const part of parts) {
    const key = getNodeKey(part);
    const existing = current.children.get(key);
    const child = existing ?? createNode(part.name, part.kind);

    if (!existing) {
      current.children.set(key, child);
    }

    child.pageCount += 1;
    current = child;
  }

  current.terminalCount += 1;
}

function freezeNode(node: MutablePathTreeNode): PathTreeNode {
  return {
    name: node.name,
    kind: node.kind,
    pageCount: node.pageCount,
    terminalCount: node.terminalCount,
    children: [...node.children.values()]
      .sort((left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind))
      .map(freezeNode),
  };
}

function renderTextTree(children: PathTreeNode[], prefix = ''): string[] {
  return children.flatMap((node, index) => {
    const isLast = index === children.length - 1;
    const connector = isLast ? '└──' : '├──';
    const childPrefix = `${prefix}${isLast ? '    ' : '│   '}`;

    return [
      `${prefix}${connector} ${node.name}`,
      ...renderTextTree(node.children, childPrefix),
    ];
  });
}

export function buildPathTree(urls: string[]): PathTreeResult {
  const root = createNode('', 'root');
  const skippedUrls: string[] = [];
  const seen = new Set<string>();

  for (const input of urls) {
    try {
      const parts = getUrlParts(input);
      const key = parts.map(getNodeKey).join('\u0001');

      if (parts.length === 0 || seen.has(key)) {
        continue;
      }

      seen.add(key);
      insertUrl(root, parts);
    } catch {
      skippedUrls.push(input);
    }
  }

  const frozenRoot = freezeNode(root);

  return {
    totalUrls: seen.size,
    skippedUrls,
    root: frozenRoot,
    text: renderTextTree(frozenRoot.children).join('\n'),
  };
}
