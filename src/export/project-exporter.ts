import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import ExcelJS from 'exceljs';
import { ZipFile } from 'yazl';

import type { DbClient } from '../db/database.js';
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
  body_text: string | null;
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
  content: string | null;
  error_message: string | null;
  meta_json: string | null;
}

export interface ProjectExportResult {
  outputPath: string;
  fileName: string;
  projectId: number;
  siteCount: number;
  pageCount: number;
  artifactFileCount: number;
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

function artifactBuffer(artifact: ArtifactExportRow | undefined): Buffer | null {
  if (!artifact) {
    return null;
  }

  return artifact.content === null ? null : Buffer.from(artifact.content, 'utf8');
}

function artifactFilePath(artifact: ArtifactExportRow | undefined): string | null {
  if (!artifact?.output_path || !existsSync(artifact.output_path)) {
    return null;
  }

  return artifact.output_path;
}

function baseCaptureBuffer(page: PageExportRow): Buffer | null {
  if (
    page.base_capture_status === 'succeeded' &&
    page.base_capture_path !== null &&
    existsSync(page.base_capture_path)
  ) {
    return null;
  }

  if (page.base_capture_status === 'succeeded' && page.body_text !== null) {
    const title = page.title ? `# ${page.title}\n\n` : '';
    const meta = page.meta_description ? `> ${page.meta_description}\n\n` : '';
    return Buffer.from(`${title}${meta}${page.body_text}\n`, 'utf8');
  }

  return null;
}

function hasSuccessfulBaseCapture(page: PageExportRow): boolean {
  return page.last_base_status === 'succeeded' || page.base_capture_status === 'succeeded';
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

function defaultExportPath(project: ProjectRow, exportedAt: string): string {
  const timestamp = exportedAt.replace(/[:.]/g, '-');
  return join('.local', 'exports', `${project.slug || `project-${project.id}`}-${timestamp}.zip`);
}

function addJson(zip: ZipFile, path: string, value: unknown): void {
  zip.addBuffer(toJsonBuffer(value), path);
}

function addTextOrFile(
  zip: ZipFile,
  input: { filePath: string | null; buffer: Buffer | null; zipPath: string },
): boolean {
  if (input.filePath) {
    zip.addFile(input.filePath, input.zipPath);
    return true;
  }

  if (input.buffer) {
    zip.addBuffer(input.buffer, input.zipPath);
    return true;
  }

  return false;
}

async function createPageListWorkbook(
  pages: PageExportRow[],
  artifacts: Map<string, ArtifactExportRow>,
  pageDirById: Map<number, string>,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Kvault Web Capture';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('pages', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = [
    { header: 'page_id', key: 'pageId', width: 12 },
    { header: 'title', key: 'title', width: 36 },
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

  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { vertical: 'middle' };

  for (const page of pages) {
    const markdown = artifacts.get(`${page.id}:markdown`);
    const screenshot = artifacts.get(`${page.id}:screenshot`);
    sheet.addRow({
      pageId: page.id,
      title: page.latest_title ?? page.title ?? '',
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
    });
  }

  sheet.autoFilter = {
    from: 'A1',
    to: `${sheet.getColumn(sheet.columnCount).letter}${Math.max(sheet.rowCount, 1)}`,
  };

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as ArrayBuffer);
}

async function writeZipFile(
  outputPath: string,
  addEntries: (zip: ZipFile) => Promise<void>,
): Promise<void> {
  mkdirSync(dirname(outputPath), { recursive: true });
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
    renameSync(tempOutputPath, outputPath);
  } catch (error) {
    output.destroy();
    try {
      unlinkSync(tempOutputPath);
    } catch {
      // Preserve the original export failure.
    }
    throw error;
  }
}

export class ProjectExporter {
  constructor(
    private readonly db: DbClient,
    private readonly clock: Clock,
  ) {}

  async exportProject(input: { projectId: number; outputPath?: string }): Promise<ProjectExportResult> {
    const project = await this.db.get<ProjectRow>(
      'SELECT id, name, slug, label_definitions_json, created_at FROM projects WHERE id = ?',
      [input.projectId],
    );

    if (!project) {
      throw new Error(`Project ${input.projectId} not found`);
    }

    const exportedAt = this.clock.now();
    const outputPath = input.outputPath ?? defaultExportPath(project, exportedAt);
    const sites = await this.db.all<SiteRow>(
        `SELECT id, project_id, name, base_url, storage_root, config_json, updated_at, created_at
         FROM sites
         WHERE project_id = ?
         ORDER BY id`,
      [project.id],
    );

    const projectPageCount = await this.countProjectPages(project.id);
    let artifactFileCount = 0;

    await writeZipFile(outputPath, async (zip) => {
      addJson(zip, 'project_info.json', {
        id: project.id,
        name: project.name,
        slug: project.slug,
        createdAt: project.created_at,
        exportedAt,
        siteCount: sites.length,
        pageCount: projectPageCount,
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
          if (!hasSuccessfulBaseCapture(page)) {
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
            addTextOrFile(zip, {
              filePath:
                page.base_capture_status === 'succeeded' &&
                page.base_capture_path !== null &&
                existsSync(page.base_capture_path)
                  ? page.base_capture_path
                  : null,
              buffer: baseCaptureBuffer(page),
              zipPath: `${pageRoot}/base.md`,
            })
          ) {
            artifactFileCount += 1;
          }

          const markdown = artifacts.get(`${page.id}:markdown`);
          if (
            addTextOrFile(zip, {
              filePath: artifactFilePath(markdown),
              buffer: artifactBuffer(markdown),
              zipPath: `${pageRoot}/markdown.md`,
            })
          ) {
            artifactFileCount += 1;
          }

          const screenshot = artifacts.get(`${page.id}:screenshot`);
          if (
            addTextOrFile(zip, {
              filePath: artifactFilePath(screenshot),
              buffer: artifactBuffer(screenshot),
              zipPath: `${pageRoot}/screenshot.png`,
            })
          ) {
            artifactFileCount += 1;
          }
        }

        zip.addBuffer(
          await createPageListWorkbook(pages, artifacts, pageDirById),
          `sites/${siteDir}/page_list.xlsx`,
        );
      }
    });

    return {
      outputPath,
      fileName: basename(outputPath),
      projectId: project.id,
      siteCount: sites.length,
      pageCount: projectPageCount,
      artifactFileCount,
    };
  }

  private async countProjectPages(projectId: number): Promise<number> {
    const row = await this.db.get<{ count: number }>(
        `SELECT COUNT(sp.id) AS count
         FROM site_pages sp
         INNER JOIN sites s ON s.id = sp.site_id
         WHERE s.project_id = ?`,
      [projectId],
    );
    return Number(row?.count ?? 0);
  }

  private async listPages(siteId: number): Promise<PageExportRow[]> {
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
           pr.body_text,
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
         WHERE sp.site_id = ?
         ORDER BY sp.id`,
      [siteId],
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
           ar.content,
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
}
