import { extname } from 'node:path';

import type { RunType } from '../../domain/types.js';
import type { ProjectExportArtifact, ProjectExportOptions } from '../../export/project-exporter.js';
import type { ChatCompletionMessageParam } from '../../utils/llm_chat.js';

export function parseSiteId(value: string): number {
  const siteId = Number(value);

  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error('siteId 无效。');
  }

  return siteId;
}

export function parseStatusFilter(value: string | string[] | undefined): string[] | undefined {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const statuses = values
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter(Boolean);
  return statuses.length > 0 ? statuses : undefined;
}

export function parseRunType(value: string | undefined): RunType | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }

  if (value !== 'seed_run' && value !== 'crawl_run') {
    throw new Error('runType 无效。');
  }

  return value;
}

export function parseProjectId(value: string): number {
  const projectId = Number(value);

  if (!Number.isInteger(projectId) || projectId <= 0) {
    throw new Error('projectId 无效。');
  }

  return projectId;
}

export function parseRunId(value: string): number {
  const runId = Number(value);

  if (!Number.isInteger(runId) || runId <= 0) {
    throw new Error('runId 无效。');
  }

  return runId;
}

export function parseSitePageId(value: string): number {
  const sitePageId = Number(value);

  if (!Number.isInteger(sitePageId) || sitePageId <= 0) {
    throw new Error('sitePageId 无效。');
  }

  return sitePageId;
}

export function parseArtifactRunId(value: string): number {
  const artifactRunId = Number(value);

  if (!Number.isInteger(artifactRunId) || artifactRunId <= 0) {
    throw new Error('artifactRunId 无效。');
  }

  return artifactRunId;
}

export function parseProjectExportOptions(value: unknown): ProjectExportOptions {
  if (typeof value !== 'object' || value === null) {
    return {};
  }

  const record = value as Record<string, unknown>;
  const siteIds = Array.isArray(record.siteIds)
    ? record.siteIds
        .map((siteId) => typeof siteId === 'number' ? siteId : Number(siteId))
        .filter((siteId) => Number.isInteger(siteId) && siteId > 0)
    : undefined;
  const allowedArtifacts = new Set<ProjectExportArtifact>(['base', 'markdown', 'screenshot', 'structured']);
  const artifacts = Array.isArray(record.artifacts)
    ? record.artifacts.filter((artifact): artifact is ProjectExportArtifact => (
        typeof artifact === 'string' && allowedArtifacts.has(artifact as ProjectExportArtifact)
      ))
    : undefined;
  const status = record.status === undefined
    ? undefined
    : parseStatusFilter(
      Array.isArray(record.status)
        ? record.status.map((item) => String(item))
        : String(record.status),
    );

  return {
    ...(siteIds ? { siteIds } : {}),
    ...(artifacts ? { artifacts } : {}),
    ...(status ? { status } : {}),
  };
}

export function parseExportArtifacts(value: unknown): ProjectExportArtifact[] | undefined {
  const allowedArtifacts = new Set<ProjectExportArtifact>(['base', 'markdown', 'screenshot', 'structured']);
  return Array.isArray(value)
    ? value.filter((artifact): artifact is ProjectExportArtifact => (
        typeof artifact === 'string' && allowedArtifacts.has(artifact as ProjectExportArtifact)
      ))
    : undefined;
}

export function parseSitePageListExportInput(siteId: number, value: unknown) {
  const record = typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {};
  const crawlRunId = record.crawlRunId === undefined
    ? undefined
    : typeof record.crawlRunId === 'number'
      ? record.crawlRunId
      : Number(record.crawlRunId);

  if (crawlRunId !== undefined && (!Number.isInteger(crawlRunId) || crawlRunId <= 0)) {
    throw new Error('crawlRunId 无效。');
  }

  const status = record.status === undefined
    ? undefined
    : parseStatusFilter(
      Array.isArray(record.status)
        ? record.status.map((item) => String(item))
        : String(record.status),
    );

  return {
    siteId,
    status,
    query: typeof record.query === 'string' ? record.query : undefined,
    label: typeof record.label === 'string' ? record.label : undefined,
    pendingReason: typeof record.pendingReason === 'string' ? record.pendingReason : undefined,
    discoverySource: typeof record.discoverySource === 'string' ? record.discoverySource : undefined,
    crawlRunId,
  };
}

export function parsePageIdList(value: unknown): number[] {
  const rawValues = Array.isArray(value) ? value : [];
  const pageIds = rawValues.map((pageId) => (
    typeof pageId === 'number' ? pageId : Number(pageId)
  ));

  if (pageIds.length === 0) {
    throw new Error('pageIds 不能为空。');
  }

  if (pageIds.some((pageId) => !Number.isInteger(pageId) || pageId <= 0)) {
    throw new Error('pageIds 中包含无效 ID。');
  }

  return pageIds;
}

export function parseLlmHistory(value: unknown): ChatCompletionMessageParam[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((message): message is { role: 'user' | 'assistant'; content: string } => {
      if (typeof message !== 'object' || message === null) {
        return false;
      }
      const record = message as Record<string, unknown>;
      return (
        (record.role === 'user' || record.role === 'assistant') &&
        typeof record.content === 'string' &&
        record.content.trim().length > 0
      );
    })
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
}

export function artifactContentType(path: string, artifactType: string): string {
  if (artifactType === 'structured') {
    return 'application/json; charset=utf-8';
  }

  if (artifactType !== 'screenshot') {
    return 'text/plain; charset=utf-8';
  }

  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}

export function parseOptionalSiteId(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const siteId = typeof value === 'number' ? value : Number(value);

  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error('siteId 无效。');
  }

  return siteId;
}

export function parseSimpleCaptureUrls(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('urls 必须是非空 URL 数组。');
  }

  if (!value.every((item) => typeof item === 'string')) {
    throw new Error('urls 必须是字符串数组。');
  }

  const urls = [...new Set(value
    .map((item) => item.trim())
    .filter(Boolean))];

  if (urls.length === 0) {
    throw new Error('urls 不能为空。');
  }

  return urls;
}
