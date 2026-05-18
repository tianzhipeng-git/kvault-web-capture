import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import ExcelJS from 'exceljs';
import { ZipFile } from 'yazl';

import type { DbClient, DbValue } from '../db/database.js';
import type { Clock } from '../utils/clock.js';

interface ProjectRow {
  id: number;
  name: string;
  slug: string;
  label_definitions_json: string;
  created_at: string;
}

interface SiteRow {
  id: number;
  project_id: number;
  name: string;
  base_url: string;
  storage_root: string;
  config_json: string;
  updated_at: string;
  created_at: string;
}

interface PageExportRow {
  id: number;
  site_id: number;
  discovered_url: string;
  normalized_url: string;
  inventory_status: string;
  discovery_source: string;
  discovery_referrer_url: string | null;
  last_pending_reason: string | null;
  latest_title: string | null;
  last_base_status: string | null;
  last_base_at: string | null;
  last_markdown_status: string | null;
  last_markdown_at: string | null;
  last_screenshot_status: string | null;
  last_screenshot_at: string | null;
  first_discovered_at: string;
  updated_at: string;
  latest_page_run_id: number | null;
  latest_crawl_run_id: number | null;
  title: string | null;
  meta_description: string | null;
  classification_labels_json: string | null;
  decision_outcome: string | null;
  decision_reason: string | null;
  pending_reason: string | null;
  required_artifacts_json: string | null;
  base_capture_status: string | null;
  base_capture_path: string | null;
  base_finished_at: string | null;
}

interface ArtifactExportRow {
  id: number;
  crawl_run_id: number;
  page_run_id: number;
  site_page_id: number;
  artifact_type: string;
  status: string;
  finished_at: string | null;
  output_path: string | null;
  has_content: number | boolean;
  error_message: string | null;
  meta_json: string | null;
}

export type ProjectExportArtifact = 'base' | 'markdown' | 'screenshot';

export interface ProjectExportOptions {
  siteIds?: number[];
  artifacts?: ProjectExportArtifact[];
}

export interface ProjectExportResult {
  outputPath: string;
  fileName: string;
  projectId: number;
  siteCount: number;
  pageCount: number;
  artifactFileCount: number;
}

export interface SitePageListExportInput {
  siteId: number;
  outputPath?: string;
  status?: string;
  query?: string;
  label?: string;
  pendingReason?: string;
  discoverySource?: string;
  crawlRunId?: number;
}

export interface SitePageListExportResult {
  outputPath: string;
  fileName: string;
  siteId: number;
  pageCount: number;
}

function parseJson<T>(value: string | null): T | null {
  if (value === null) {
    return null;
  }
  return JSON.parse(value) as T;
}

function toJsonBuffer(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sanitizeSegment(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

function limitUtf8Bytes(value: string, maxBytes: number): string {
  let output = '';
  let bytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) {
      break;
    }
    output += char;
    bytes += charBytes;
  }
  return output;
}

function safeDirectoryName(prefix: string, label: string, maxBytes = 120): string {
  const sanitized = sanitizeSegment(label, 'item');
  const budget = Math.max(maxBytes - Buffer.byteLength(`${prefix}_`, 'utf8'), 16);
  return `${prefix}_${limitUtf8Bytes(sanitized, budget)}`;
}

function urlDirectoryLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}${parsed.search}`.replace(/\/$/, '_');
  } catch {
    return url;
  }
}

function latestArtifactMap(rows: ArtifactExportRow[]): Map<string, ArtifactExportRow> {
  const map = new Map<string, ArtifactExportRow>();
  for (const row of rows) {
    map.set(`${row.site_page_id}:${row.artifact_type}`, row);
  }
  return map;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function hasSuccessfulBaseCapture(page: PageExportRow): boolean {
  return page.last_base_status === 'succeeded' || page.base_capture_status === 'succeeded';
}

function hasInlineArtifactContent(artifact: ArtifactExportRow | undefined): boolean {
  return artifact?.has_content === true || artifact?.has_content === 1;
}

function flattenLabels(value: string | null): string {
  const labels = parseJson<Record<string, string[]>>(value) ?? {};
  return Object.entries(labels)
    .flatMap(([key, values]) => values.map((label) => `${key}: ${label}`))
    .join('; ');
}

function requiredArtifacts(value: string | null): string {
  return (parseJson<string[]>(value) ?? []).join(', ');
}

function normalizeExportArtifacts(artifacts: ProjectExportOptions['artifacts']): Set<ProjectExportArtifact> {
  return new Set(artifacts ?? ['base', 'markdown', 'screenshot']);
}

function excelColumnLetter(index: number): string {
  let value = index;
  let output = '';
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output;
}

function defaultExportPath(project: ProjectRow, exportedAt: string): string {
  const timestamp = exportedAt.replace(/[:.]/g, '-');
  return join('.local', 'exports', `${project.slug || `project-${project.id}`}-${timestamp}.zip`);
}

function defaultSitePageListExportPath(site: SiteRow, exportedAt: string): string {
  const timestamp = exportedAt.replace(/[:.]/g, '-');
  return join(
    '.local',
    'exports',
    `${sanitizeSegment(site.name, `site-${site.id}`)}-pages-${timestamp}.xlsx`,
  );
}

function buildPageFilters(input: SitePageListExportInput): { whereClause: string; args: DbValue[] } {
  const filters: string[] = ['sp.site_id = ?'];
  const args: DbValue[] = [input.siteId];

  if (input.status) {
    filters.push('sp.inventory_status = ?');
    args.push(input.status);
  }

  if (input.query) {
    filters.push('(sp.normalized_url LIKE ? OR COALESCE(sp.latest_title, \'\') LIKE ?)');
    args.push(`%${input.query}%`, `%${input.query}%`);
  }

  if (input.pendingReason) {
    filters.push('sp.last_pending_reason = ?');
    args.push(input.pendingReason);
  }

  if (input.discoverySource) {
    filters.push('sp.discovery_source = ?');
    args.push(input.discoverySource);
  }

  if (input.crawlRunId !== undefined) {
    filters.push(
      `(EXISTS (
         SELECT 1
         FROM page_runs pr_run_filter
         WHERE pr_run_filter.site_page_id = sp.id
           AND pr_run_filter.crawl_run_id = ?
       ) OR EXISTS (
         SELECT 1
         FROM artifact_runs ar_run_filter
         WHERE ar_run_filter.site_page_id = sp.id
           AND ar_run_filter.crawl_run_id = ?
       ))`,
    );
    args.push(input.crawlRunId, input.crawlRunId);
  }

  if (input.label) {
    filters.push(
      `EXISTS (
         SELECT 1
         FROM page_runs prt
         WHERE prt.site_page_id = sp.id
           AND prt.id = (
             SELECT pr2.id
             FROM page_runs pr2
             WHERE pr2.site_page_id = sp.id
             ORDER BY pr2.id DESC
             LIMIT 1
           )
           AND prt.classification_labels_json LIKE ?
       )`,
    );
    args.push(`%${input.label}%`);
  }

  return { whereClause: filters.join(' AND '), args };
}

function addJson(zip: ZipFile, path: string, value: unknown): void {
  zip.addBuffer(toJsonBuffer(value), path);
}

async function addFileIfExists(
  zip: ZipFile,
  input: { filePath: string | null; zipPath: string },
): Promise<boolean> {
  if (!input.filePath || !(await pathExists(input.filePath))) {
    return false;
  }

  zip.addFile(input.filePath, input.zipPath);
  return true;
}

let tempFileCounter = 0;

function createTempFilePath(outputPath: string, label: string): string {
  tempFileCounter += 1;
  return `${outputPath}.tmp-${process.pid}-${Date.now()}-${tempFileCounter}-${label}`;
}

function addTextBuffer(
  zip: ZipFile,
  input: { content: string | null; zipPath: string },
): boolean {
  if (input.content === null) {
    return false;
  }

  zip.addBuffer(Buffer.from(input.content, 'utf8'), input.zipPath);
  return true;
}

async function addFileOrTextBuffer(
  zip: ZipFile,
  input: { filePath: string | null; content: () => Promise<string | null>; zipPath: string },
): Promise<boolean> {
  if (await addFileIfExists(zip, { filePath: input.filePath, zipPath: input.zipPath })) {
    return true;
  }

  return addTextBuffer(zip, {
    content: await input.content(),
    zipPath: input.zipPath,
  });
}

async function addArtifactFileOrInlineContent(
  zip: ZipFile,
  input: {
    artifact: ArtifactExportRow | undefined;
    zipPath: string;
    readContent: (artifactRunId: number) => Promise<string | null>;
  },
): Promise<boolean> {
  if (await addFileIfExists(zip, {
    filePath: input.artifact?.output_path ?? null,
    zipPath: input.zipPath,
  })) {
    return true;
  }

  if (!input.artifact || !hasInlineArtifactContent(input.artifact)) {
    return false;
  }

  return addTextBuffer(zip, {
    content: await input.readContent(input.artifact.id),
    zipPath: input.zipPath,
  });
}

async function writePageListWorkbook(
  outputPath: string,
  pages: PageExportRow[],
  artifacts: Map<string, ArtifactExportRow>,
  pageDirById: Map<number, string>,
): Promise<void> {
  const columns = [
    { header: 'page_id', key: 'pageId', width: 12 },
    { header: 'title', key: 'title', width: 36 },
    { header: 'meta_description', key: 'metaDescription', width: 44 },
    { header: 'normalized_url', key: 'normalizedUrl', width: 48 },
    { header: 'discovered_url', key: 'discoveredUrl', width: 48 },
    { header: 'inventory_status', key: 'inventoryStatus', width: 20 },
    { header: 'discovery_source', key: 'discoverySource', width: 20 },
    { header: 'first_discovered_at', key: 'firstDiscoveredAt', width: 26 },
    { header: 'updated_at', key: 'updatedAt', width: 26 },
    { header: 'latest_page_run_id', key: 'latestPageRunId', width: 18 },
    { header: 'latest_crawl_run_id', key: 'latestCrawlRunId', width: 18 },
    { header: 'latest_decision_outcome', key: 'latestDecisionOutcome', width: 24 },
    { header: 'latest_decision_reason', key: 'latestDecisionReason', width: 32 },
    { header: 'pending_reason', key: 'pendingReason', width: 22 },
    { header: 'required_artifacts', key: 'requiredArtifacts', width: 22 },
    { header: 'labels', key: 'labels', width: 36 },
    { header: 'base_status', key: 'baseStatus', width: 18 },
    { header: 'base_at', key: 'baseAt', width: 26 },
    { header: 'markdown_status', key: 'markdownStatus', width: 18 },
    { header: 'markdown_at', key: 'markdownAt', width: 26 },
    { header: 'screenshot_status', key: 'screenshotStatus', width: 18 },
    { header: 'screenshot_at', key: 'screenshotAt', width: 26 },
    { header: 'base_source_path', key: 'baseSourcePath', width: 48 },
    { header: 'markdown_source_path', key: 'markdownSourcePath', width: 48 },
    { header: 'screenshot_source_path', key: 'screenshotSourcePath', width: 48 },
    { header: 'export_page_dir', key: 'exportPageDir', width: 54 },
  ];
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: outputPath,
    useStyles: true,
    useSharedStrings: true,
  });
  workbook.creator = 'Kvault Web Capture';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('pages', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = columns;

  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { vertical: 'middle' };
  sheet.getRow(1).commit();

  for (const page of pages) {
    const markdown = artifacts.get(`${page.id}:markdown`);
    const screenshot = artifacts.get(`${page.id}:screenshot`);
    sheet.addRow({
      pageId: page.id,
      title: page.latest_title ?? page.title ?? '',
      metaDescription: page.meta_description ?? '',
      normalizedUrl: page.normalized_url,
      discoveredUrl: page.discovered_url,
      inventoryStatus: page.inventory_status,
      discoverySource: page.discovery_source,
      firstDiscoveredAt: page.first_discovered_at,
      updatedAt: page.updated_at,
      latestPageRunId: page.latest_page_run_id,
      latestCrawlRunId: page.latest_crawl_run_id,
      latestDecisionOutcome: page.decision_outcome ?? '',
      latestDecisionReason: page.decision_reason ?? '',
      pendingReason: page.pending_reason ?? page.last_pending_reason ?? '',
      requiredArtifacts: requiredArtifacts(page.required_artifacts_json),
      labels: flattenLabels(page.classification_labels_json),
      baseStatus: page.base_capture_status ?? page.last_base_status ?? '',
      baseAt: page.last_base_at ?? '',
      markdownStatus: page.last_markdown_status ?? '',
      markdownAt: page.last_markdown_at ?? '',
      screenshotStatus: page.last_screenshot_status ?? '',
      screenshotAt: page.last_screenshot_at ?? '',
      baseSourcePath: page.base_capture_path ?? '',
      markdownSourcePath: markdown?.output_path ?? '',
      screenshotSourcePath: screenshot?.output_path ?? '',
      exportPageDir: pageDirById.get(page.id) ?? '',
    }).commit();
  }

  sheet.autoFilter = {
    from: 'A1',
    to: `${excelColumnLetter(columns.length)}${Math.max(pages.length + 1, 1)}`,
  };

  await workbook.commit();
}

async function writeZipFile(
  outputPath: string,
  addEntries: (zip: ZipFile) => Promise<void>,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  const tempOutputPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  const zip = new ZipFile();
  const output = createWriteStream(tempOutputPath);
  const completion = new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    zip.on('error', reject);
    zip.outputStream.on('error', reject);
  });

  zip.outputStream.pipe(output);

  try {
    await addEntries(zip);
    zip.end();
    await completion;
    await rename(tempOutputPath, outputPath);
  } catch (error) {
    output.destroy();
    await rm(tempOutputPath, { force: true });
    throw error;
  }
}

export class ProjectExporter {
  constructor(
    private readonly db: DbClient,
    private readonly clock: Clock,
  ) {}

  async exportProject(input: { projectId: number; outputPath?: string; options?: ProjectExportOptions }): Promise<ProjectExportResult> {
    const project = await this.db.get<ProjectRow>(
      'SELECT id, name, slug, label_definitions_json, created_at FROM projects WHERE id = ?',
      [input.projectId],
    );

    if (!project) {
      throw new Error(`Project ${input.projectId} not found`);
    }

    const exportedAt = this.clock.now();
    const outputPath = input.outputPath ?? defaultExportPath(project, exportedAt);
    const selectedArtifacts = normalizeExportArtifacts(input.options?.artifacts);
    const shouldExportPageArtifacts = selectedArtifacts.size > 0;
    const siteIds = input.options?.siteIds?.filter((siteId) => Number.isInteger(siteId) && siteId > 0);
    const siteFilter = siteIds === undefined
      ? ''
      : siteIds.length > 0
        ? ` AND id IN (${siteIds.map(() => '?').join(', ')})`
        : ' AND 1 = 0';
    const sites = await this.db.all<SiteRow>(
        `SELECT id, project_id, name, base_url, storage_root, config_json, updated_at, created_at
         FROM sites
         WHERE project_id = ?${siteFilter}
         ORDER BY id`,
      [project.id, ...(siteIds ?? [])],
    );

    const projectPageCount = await this.countProjectPages(project.id, siteIds);
    const tempFiles: string[] = [];
    let artifactFileCount = 0;

    try {
      await writeZipFile(outputPath, async (zip) => {
        addJson(zip, 'project_info.json', {
          id: project.id,
          name: project.name,
          slug: project.slug,
          createdAt: project.created_at,
          exportedAt,
          siteCount: sites.length,
          pageCount: projectPageCount,
          exportOptions: {
            siteIds: siteIds === undefined ? 'all' : siteIds,
            artifacts: [...selectedArtifacts],
          },
          labelDefinitions: parseJson<unknown>(project.label_definitions_json),
        });

        for (const site of sites) {
          const siteDir = safeDirectoryName(`site-${site.id}`, site.name);
          const pages = await this.listPages(site.id);
          const artifacts = latestArtifactMap(await this.listLatestSuccessfulArtifacts(site.id));
          const pageDirById = new Map<number, string>();

          addJson(zip, `sites/${siteDir}/site_info.json`, {
            id: site.id,
            projectId: site.project_id,
            name: site.name,
            baseUrl: site.base_url,
            storageRoot: site.storage_root,
            createdAt: site.created_at,
            updatedAt: site.updated_at,
            exportedAt,
            pageCount: pages.length,
            config: parseJson<unknown>(site.config_json),
          });

          for (const page of pages) {
            if (!shouldExportPageArtifacts || !hasSuccessfulBaseCapture(page)) {
              continue;
            }

            const pageDir = safeDirectoryName(String(page.id), urlDirectoryLabel(page.normalized_url));
            const pageRoot = `sites/${siteDir}/pages/${pageDir}`;
            pageDirById.set(page.id, pageRoot);

            addJson(zip, `${pageRoot}/page_info.json`, {
              sitePageId: page.id,
              siteId: page.site_id,
              discoveredUrl: page.discovered_url,
              normalizedUrl: page.normalized_url,
              title: page.latest_title ?? page.title,
              inventoryStatus: page.inventory_status,
              discoverySource: page.discovery_source,
              discoveryReferrerUrl: page.discovery_referrer_url,
              firstDiscoveredAt: page.first_discovered_at,
              updatedAt: page.updated_at,
              latestPageRun: page.latest_page_run_id
                ? {
                    pageRunId: page.latest_page_run_id,
                    crawlRunId: page.latest_crawl_run_id,
                    title: page.title,
                    metaDescription: page.meta_description,
                    decisionOutcome: page.decision_outcome,
                    decisionReason: page.decision_reason,
                    pendingReason: page.pending_reason,
                    requiredArtifacts: parseJson<unknown>(page.required_artifacts_json),
                    classificationLabels: parseJson<unknown>(page.classification_labels_json),
                    baseCaptureStatus: page.base_capture_status,
                    baseCapturePath: page.base_capture_path,
                    finishedAt: page.base_finished_at,
                  }
                : null,
            });

            if (
              selectedArtifacts.has('base') &&
              await addFileOrTextBuffer(zip, {
                filePath:
                  page.base_capture_status === 'succeeded' &&
                  page.base_capture_path !== null
                    ? page.base_capture_path
                    : null,
                content: () => this.getBaseCaptureFallbackContent(page.id),
                zipPath: `${pageRoot}/base.md`,
              })
            ) {
              artifactFileCount += 1;
            }

            const markdown = artifacts.get(`${page.id}:markdown`);
            if (
              selectedArtifacts.has('markdown') &&
              await addArtifactFileOrInlineContent(zip, {
                artifact: markdown,
                zipPath: `${pageRoot}/markdown.md`,
                readContent: (artifactRunId) => this.getArtifactContent(artifactRunId),
              })
            ) {
              artifactFileCount += 1;
            }

            const screenshot = artifacts.get(`${page.id}:screenshot`);
            if (
              selectedArtifacts.has('screenshot') &&
              await addArtifactFileOrInlineContent(zip, {
                artifact: screenshot,
                zipPath: `${pageRoot}/screenshot.png`,
                readContent: (artifactRunId) => this.getArtifactContent(artifactRunId),
              })
            ) {
              artifactFileCount += 1;
            }
          }

          const pageListPath = createTempFilePath(outputPath, `site-${site.id}-page-list.xlsx`);
          tempFiles.push(pageListPath);
          await writePageListWorkbook(pageListPath, pages, artifacts, pageDirById);
          zip.addFile(pageListPath, `sites/${siteDir}/page_list.xlsx`);
        }
      });
    } finally {
      for (const tempFile of tempFiles) {
        await rm(tempFile, { force: true });
      }
    }

    return {
      outputPath,
      fileName: basename(outputPath),
      projectId: project.id,
      siteCount: sites.length,
      pageCount: projectPageCount,
      artifactFileCount,
    };
  }

  async exportSitePageList(input: SitePageListExportInput): Promise<SitePageListExportResult> {
    const site = await this.db.get<SiteRow>(
        `SELECT id, project_id, name, base_url, storage_root, config_json, updated_at, created_at
         FROM sites
         WHERE id = ?`,
      [input.siteId],
    );

    if (!site) {
      throw new Error(`Site ${input.siteId} not found`);
    }

    const exportedAt = this.clock.now();
    const outputPath = input.outputPath ?? defaultSitePageListExportPath(site, exportedAt);
    await mkdir(dirname(outputPath), { recursive: true });

    const pages = await this.listPages(input.siteId, input);
    const artifacts = latestArtifactMap(await this.listLatestSuccessfulArtifacts(input.siteId));
    await writePageListWorkbook(outputPath, pages, artifacts, new Map());

    return {
      outputPath,
      fileName: basename(outputPath),
      siteId: site.id,
      pageCount: pages.length,
    };
  }

  private async countProjectPages(projectId: number, siteIds?: number[]): Promise<number> {
    const siteFilter = siteIds === undefined
      ? ''
      : siteIds.length > 0
        ? ` AND s.id IN (${siteIds.map(() => '?').join(', ')})`
        : ' AND 1 = 0';
    const row = await this.db.get<{ count: number }>(
        `SELECT COUNT(sp.id) AS count
         FROM site_pages sp
         INNER JOIN sites s ON s.id = sp.site_id
         WHERE s.project_id = ?${siteFilter}`,
      [projectId, ...(siteIds ?? [])],
    );
    return Number(row?.count ?? 0);
  }

  private async listPages(
    siteId: number,
    filters?: Omit<SitePageListExportInput, 'siteId'>,
  ): Promise<PageExportRow[]> {
    const { whereClause, args } = buildPageFilters({ siteId, ...filters });
    return this.db.all<PageExportRow>(
        `SELECT
           sp.id,
           sp.site_id,
           sp.discovered_url,
           sp.normalized_url,
           sp.inventory_status,
           sp.discovery_source,
           sp.discovery_referrer_url,
           sp.last_pending_reason,
           sp.latest_title,
           sp.last_base_status,
           sp.last_base_at,
           sp.last_markdown_status,
           sp.last_markdown_at,
           sp.last_screenshot_status,
           sp.last_screenshot_at,
           sp.first_discovered_at,
           sp.updated_at,
           pr.id AS latest_page_run_id,
           pr.crawl_run_id AS latest_crawl_run_id,
           pr.title,
           pr.meta_description,
           pr.classification_labels_json,
           pr.decision_outcome,
           pr.decision_reason,
           pr.pending_reason,
           pr.required_artifacts_json,
           pr.base_capture_status,
           pr.base_capture_path,
           pr.finished_at AS base_finished_at
         FROM site_pages sp
         LEFT JOIN page_runs pr ON pr.id = (
           SELECT pr2.id
           FROM page_runs pr2
           WHERE pr2.site_page_id = sp.id
           ORDER BY pr2.id DESC
           LIMIT 1
         )
         WHERE ${whereClause}
         ORDER BY sp.id`,
      args,
    );
  }

  private async listLatestSuccessfulArtifacts(siteId: number): Promise<ArtifactExportRow[]> {
    const rows = await this.db.all<ArtifactExportRow>(
        `SELECT
           ar.id,
           ar.crawl_run_id,
           ar.page_run_id,
           ar.site_page_id,
           ar.artifact_type,
           ar.status,
           ar.finished_at,
           ar.output_path,
           ar.content IS NOT NULL AS has_content,
           ar.error_message,
           ar.meta_json
         FROM artifact_runs ar
         INNER JOIN site_pages sp ON sp.id = ar.site_page_id
         WHERE sp.site_id = ? AND ar.status = 'succeeded'
         ORDER BY ar.site_page_id ASC, ar.artifact_type ASC, ar.id DESC`,
      [siteId],
    );

    const seen = new Set<string>();
    return rows.filter((row) => {
      const key = `${row.site_page_id}:${row.artifact_type}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  private async getBaseCaptureFallbackContent(sitePageId: number): Promise<string | null> {
    const row = await this.db.get<{
      title: string | null;
      meta_description: string | null;
      body_text: string | null;
      base_capture_status: string | null;
    }>(
        `SELECT title, meta_description, body_text, base_capture_status
         FROM page_runs
         WHERE site_page_id = ?
         ORDER BY id DESC
         LIMIT 1`,
      [sitePageId],
    );

    if (!row || row.base_capture_status !== 'succeeded' || row.body_text === null) {
      return null;
    }

    const title = row.title ? `# ${row.title}\n\n` : '';
    const meta = row.meta_description ? `> ${row.meta_description}\n\n` : '';
    return `${title}${meta}${row.body_text}\n`;
  }

  private async getArtifactContent(artifactRunId: number): Promise<string | null> {
    const row = await this.db.get<{ content: string | null }>(
      'SELECT content FROM artifact_runs WHERE id = ?',
      [artifactRunId],
    );
    return row?.content ?? null;
  }
}
