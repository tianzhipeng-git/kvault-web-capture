/// <reference types="vite/client" />
export type RunType = "seed_run" | "crawl_run";
export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

function buildQueryString(params: object): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== "") q.append(key, String(item));
      }
      continue;
    }
    q.set(key, String(value));
  }
  return q.toString();
}

export interface SiteRunListItem {
  runId: number;
  runType: RunType;
  runTypeLabel: string;
  status: RunStatus;
  statusLabel: string;
  startedAt: string;
  finishedAt: string | null;
  successfulPages: number;
  pendingPages: number;
  deniedPages: number;
  targetSuccessCount: number | null;
  errorMessage?: string | null;
}

export interface RunLogItem {
  logId: number;
  crawlRunId: number;
  sitePageId: number | null;
  pageRunId: number | null;
  level: string;
  event: string;
  url: string | null;
  message: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export interface RuntimeLogResponse {
  relativePath: string;
  content: string;
  truncated: boolean;
}

export interface PathTreeNode {
  name: string;
  kind: "root" | "domain" | "path";
  pageCount: number;
  terminalCount: number;
  children: PathTreeNode[];
}

export interface PathTreeResponse {
  totalUrls: number;
  skippedUrls: string[];
  root: PathTreeNode;
  text: string;
}

export type ProjectExportArtifact = "base" | "markdown" | "screenshot" | "structured";

export interface ProjectExportOptions {
  siteIds?: number[];
  artifacts?: ProjectExportArtifact[];
  status?: string | string[];
}

export interface SitePageIdExportOptions {
  pageIds: number[];
  artifacts?: ProjectExportArtifact[];
}

export interface PreparedExport {
  token: string;
  fileName: string;
  expiresInSeconds: number;
  downloadUrl: string;
}

export interface DefaultSiteSetting {
  defaultSite: {
    siteId: number;
    siteName: string;
    projectId: number;
    baseUrl: string;
  } | null;
}

export interface SystemConfigResponse {
  config: {
    urlNormalization: {
      stripQueryParams: string[];
      stripQueryParamPrefixes?: string[];
    };
  };
}

export interface SitePageListParams {
  page?: number;
  pageSize?: number;
  status?: string | string[];
  query?: string;
  label?: string;
  pendingReason?: string;
  discoverySource?: string;
  crawlRunId?: number;
}

export interface SitePageListRow {
  sitePageId: number;
  title: string;
  url: string;
  businessStatus: string;
  labels: string[];
  latestOutcome: string;
  latestHandledAt: string | null;
  needsReview: boolean;
  pendingReasonLabel: string | null;
  discoverySource: string;
  captureSummary: string;
}

export interface ProcessingState {
  kind: "base" | "markdown" | "screenshot" | "structured";
  label: string;
  shouldRun: boolean;
  succeeded: boolean;
  status: string | null;
  statusLabel: string;
  reason: string;
  runId: number | null;
  handledAt: string | null;
  outputPath: string | null;
  errorMessage: string | null;
  toolName: string | null;
}

export interface SitePageDetail {
  sitePageId: number;
  siteId: number;
  title: string;
  url: string;
  discoveredUrl: string;
  businessStatus: string;
  discoverySource: string;
  discoveryReferrerUrl: string | null;
  firstDiscoveredAt: string;
  updatedAt: string;
  latestLabels: string[];
  latestDecision: string | null;
  latestPendingReasonLabel: string | null;
  latestBase: ProcessingState;
  latestMarkdown: ProcessingState;
  latestScreenshot: ProcessingState;
  latestStructured: ProcessingState;
  latestPageRun: null | {
    pageRunId: number;
    crawlRunId: number;
    title: string;
    metaDescription: string;
    bodyText: string;
    requiredArtifacts: string[];
    decisionOutcome: string;
    decisionReason: string | null;
    pendingReasonLabel: string | null;
  };
  latestPreviews: {
    base: {
      outputPath: string | null;
      content: string | null;
    };
    markdown: {
      artifactRunId: number | null;
      outputPath: string | null;
      content: string | null;
    };
    screenshot: {
      artifactRunId: number | null;
      outputPath: string | null;
    };
    structured: {
      artifactRunId: number | null;
      outputPath: string | null;
      content: string | null;
    };
  };
  runHistory: Array<{
    runId: number;
    runTypeLabel: string;
    statusLabel: string;
    startedAt: string;
    finishedAt: string | null;
    pageRuns: Array<{
      pageRunId: number;
      title: string;
      decisionOutcome: string;
      decisionReason: string | null;
      pendingReasonLabel: string | null;
      requiredArtifacts: string[];
      labels: string[];
      baseStatus: string;
      baseCapturePath: string | null;
      bodyPreview: string;
    }>;
    artifactRuns: Array<{
      artifactRunId: number;
      pageRunId: number;
      artifactType: string;
      status: string;
      outputPath: string | null;
      contentPreview: string;
      errorMessage: string | null;
      finishedAt: string | null;
    }>;
  }>;
}

export interface LlmChatMessage {
  role: "user" | "assistant";
  content: string;
}

const baseUrl = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');

async function fetchApi(url: string, options?: RequestInit) {
  const res = await fetch(`${baseUrl}${url}`, options);
  if (res.status === 401) {
    const loginPath = `${import.meta.env.BASE_URL ?? '/'}login`;
    if (window.location.pathname !== loginPath && window.location.pathname !== '/login') {
      window.location.href = loginPath;
    }
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || 'API request failed');
  }
  return res.json();
}

function preparedExportDownloadUrl(token: string): string {
  return `${baseUrl}/api/exports/download/${encodeURIComponent(token)}`;
}

async function fetchPreparedExport(url: string, options?: RequestInit): Promise<PreparedExport> {
  const result = await fetchApi(url, options) as Omit<PreparedExport, 'downloadUrl'>;
  return {
    ...result,
    downloadUrl: preparedExportDownloadUrl(result.token),
  };
}

export function triggerPreparedExportDownload(prepared: PreparedExport): void {
  const link = document.createElement('a');
  link.href = prepared.downloadUrl;
  link.download = prepared.fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export const api = {
  login: (password: string) => fetchApi('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  }),
  logout: () => fetchApi('/api/auth/logout', { method: 'POST' }),
  getSession: () => fetchApi('/api/auth/session'),
  expandLinks: (url: string): Promise<{
    sourceUrl: string;
    sourceType: 'sitemap' | 'page';
    links: string[];
  }> => fetchApi('/api/links/expand', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  }),

  llmChat: (data: {
    promptName: string;
    promptVersion?: string;
    context: Record<string, unknown>;
    history?: LlmChatMessage[];
    model?: string;
    temperature?: number;
    responseFormat?: "json_object" | "text";
  }): Promise<{ content: string }> => fetchApi('/api/llm/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  }),

  getProjects: () => fetchApi('/api/projects'),
  createProject: (name: string) => fetchApi('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  }),
  getProjectLabelDefinitions: (projectId: number) => fetchApi(`/api/projects/${projectId}/label-definitions`),
  updateProjectLabelDefinitions: (projectId: number, labelDefinitions: unknown) => fetchApi(`/api/projects/${projectId}/label-definitions`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ labelDefinitions })
  }),
  prepareProjectExport: (projectId: number, options?: ProjectExportOptions): Promise<PreparedExport> =>
    fetchPreparedExport(`/api/projects/${projectId}/export/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options ?? {}),
    }),

  getDefaultSite: (): Promise<DefaultSiteSetting> => fetchApi('/api/system/default-site'),
  setDefaultSite: (siteId: number | null): Promise<DefaultSiteSetting & { status: string }> => fetchApi('/api/system/default-site', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ siteId }),
  }),
  getSystemConfig: (): Promise<SystemConfigResponse> => fetchApi('/api/system/config'),
  updateSystemUrlNormalization: (input: {
    stripQueryParams: string[];
    stripQueryParamPrefixes: string[];
  }): Promise<SystemConfigResponse & { status: string }> => fetchApi('/api/system/url-normalization', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }),
  submitSimpleCapture: (url: string): Promise<{ runId: number; siteId: number; statusLabel: string }> => fetchApi('/api/simple-capture/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, updatePolicy: 'force_recrawl_all' }),
  }),
  
  getSites: (projectId: number) => fetchApi(`/api/projects/${projectId}/sites`),
  createSite: (data: any) => fetchApi('/api/sites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  }),
  
  getSiteOverview: (siteId: number) => fetchApi(`/api/sites/${siteId}/overview`),
  getSitePathTree: (siteId: number): Promise<PathTreeResponse> => fetchApi(`/api/sites/${siteId}/path-tree`),
  getSiteConfig: (siteId: number) => fetchApi(`/api/sites/${siteId}/config`),
  updateSiteConfig: (siteId: number, config: any) => fetchApi(`/api/sites/${siteId}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  }),
  cloneSiteConfig: (siteId: number, sourceSiteId: number) => fetchApi(`/api/sites/${siteId}/config/clone-from/${sourceSiteId}`, {
    method: 'POST'
  }),
  
  startSeedRun: (siteId: number, config: any = {}) => fetchApi(`/api/sites/${siteId}/runs/seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  }),
  startCrawlRun: (siteId: number, config: any) => fetchApi(`/api/sites/${siteId}/runs/crawl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  }),
  
  getSiteRuns: (siteId: number) => fetchApi(`/api/sites/${siteId}/runs`),
  getRunSummary: (runId: number) => fetchApi(`/api/runs/${runId}`),
  cancelRun: (runId: number): Promise<{ runId: number; statusLabel: string }> => fetchApi(`/api/runs/${runId}/cancel`, {
    method: 'POST',
  }),
  getRunPageIds: (runId: number): Promise<{ runId: number; siteId: number; pageIds: number[] }> =>
    fetchApi(`/api/runs/${runId}/page-ids`),
  prepareRunExport: (runId: number, options?: { artifacts?: ProjectExportArtifact[] }): Promise<PreparedExport> =>
    fetchPreparedExport(`/api/runs/${runId}/export/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options ?? {}),
    }),
  
  getSitePages: (siteId: number, params: SitePageListParams) => {
    const q = buildQueryString(params);
    return fetchApi(`/api/sites/${siteId}/pages?${q}`);
  },
  prepareSitePagesExport: (
    siteId: number,
    params: Omit<SitePageListParams, 'page' | 'pageSize'>,
  ): Promise<PreparedExport> =>
    fetchPreparedExport(`/api/sites/${siteId}/pages/export/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),
  prepareSitePagesByIdsExport: (siteId: number, options: SitePageIdExportOptions): Promise<PreparedExport> =>
    fetchPreparedExport(`/api/sites/${siteId}/pages/export-by-ids/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    }),
  getSitePageDetail: (siteId: number, sitePageId: number) => fetchApi(`/api/sites/${siteId}/pages/${sitePageId}`),
  getPendingReview: (siteId: number) => fetchApi(`/api/sites/${siteId}/pending-review`),
  getRunLogs: (runId: number, params?: { sitePageId?: number }): Promise<{ items: RunLogItem[]; errorMessage: string | null }> => {
    const q = params?.sitePageId ? `?sitePageId=${params.sitePageId}` : "";
    return fetchApi(`/api/runs/${runId}/logs${q}`);
  },
  getRuntimeLog: (runId: number, tail = 500): Promise<RuntimeLogResponse> =>
    fetchApi(`/api/runs/${runId}/runtime-log?tail=${tail}`),

  previewRules: (siteId: number, data: {
    url: string;
    labels?: Record<string, string[]>;
    rulesBeforeBaseEq?: unknown[];
    rulesBeforeStage2Eq?: unknown[];
  }) => fetchApi(`/api/sites/${siteId}/rules/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }),
};
