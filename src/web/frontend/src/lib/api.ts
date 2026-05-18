/// <reference types="vite/client" />
export type RunType = "seed_run" | "crawl_run";

export interface SiteRunListItem {
  runId: number;
  runType: RunType;
  runTypeLabel: string;
  status: string;
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

export type ProjectExportArtifact = "base" | "markdown" | "screenshot";

export interface ProjectExportOptions {
  siteIds?: number[];
  artifacts?: ProjectExportArtifact[];
}

export interface PreparedProjectExport {
  token: string;
  fileName: string;
  expiresInSeconds: number;
  downloadUrl: string;
}

export interface SitePageListParams {
  page?: number;
  pageSize?: number;
  status?: string;
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
  kind: "base" | "markdown" | "screenshot";
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

async function fetchBlobApi(url: string, options?: RequestInit) {
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

  const disposition = res.headers.get('Content-Disposition') ?? '';
  const filenameMatch = /filename="([^"]+)"/.exec(disposition);
  return {
    blob: await res.blob(),
    filename: filenameMatch?.[1] ?? 'project-export.zip',
  };
}

export const api = {
  login: (password: string) => fetchApi('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  }),
  logout: () => fetchApi('/api/auth/logout', { method: 'POST' }),
  getSession: () => fetchApi('/api/auth/session'),

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
  exportProject: (projectId: number, options?: ProjectExportOptions): Promise<{ blob: Blob; filename: string }> => fetchBlobApi(`/api/projects/${projectId}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options ?? {})
  }),
  prepareProjectExport: async (projectId: number, options?: ProjectExportOptions): Promise<PreparedProjectExport> => {
    const result = await fetchApi(`/api/projects/${projectId}/export/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options ?? {})
    }) as Omit<PreparedProjectExport, "downloadUrl">;
    return {
      ...result,
      downloadUrl: `${baseUrl}/api/projects/${projectId}/export/download/${encodeURIComponent(result.token)}`,
    };
  },
  
  getSites: (projectId: number) => fetchApi(`/api/projects/${projectId}/sites`),
  createSite: (data: any) => fetchApi('/api/sites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  }),
  
  getSiteOverview: (siteId: number) => fetchApi(`/api/sites/${siteId}/overview`),
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
  
  getSitePages: (siteId: number, params: SitePageListParams) => {
    const q = new URLSearchParams(
      Object.entries(params).reduce<Record<string, string>>((acc, [key, value]) => {
        if (value !== undefined && value !== "") acc[key] = String(value);
        return acc;
      }, {})
    ).toString();
    return fetchApi(`/api/sites/${siteId}/pages?${q}`);
  },
  exportSitePages: (siteId: number, params: Omit<SitePageListParams, "page" | "pageSize">): Promise<{ blob: Blob; filename: string }> => {
    const q = new URLSearchParams(
      Object.entries(params).reduce<Record<string, string>>((acc, [key, value]) => {
        if (value !== undefined && value !== "") acc[key] = String(value);
        return acc;
      }, {})
    ).toString();
    return fetchBlobApi(`/api/sites/${siteId}/pages/export?${q}`);
  },
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
