import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';
import yauzl from 'yauzl';

import { CaptureApp } from '../src/app/capture-app.js';
import { createDefaultSiteConfig } from '../src/config/site-config.js';
import { initializeSchema, openDatabase } from '../src/db/database.js';
import {
  ArtifactRunRepository,
  PageRunRepository,
  ProjectRepository,
  RunRepository,
  SitePageRepository,
  SiteRepository,
} from '../src/db/repositories/index.js';
import { SystemClock } from '../src/utils/clock.js';
import { createTempDir } from './helpers/tmp.js';

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (error, zipFile) => {
      if (error) {
        reject(error);
        return;
      }

      if (!zipFile) {
        reject(new Error('Failed to open zip'));
        return;
      }

      resolve(zipFile);
    });
  });
}

function readEntry(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      if (!stream) {
        reject(new Error(`Failed to read ${entry.fileName}`));
        return;
      }

      streamToBuffer(stream).then(resolve, reject);
    });
  });
}

async function readZipEntries(path: string): Promise<Map<string, Buffer>> {
  const zipFile = await openZip(path);
  const entries = new Map<string, Buffer>();

  return new Promise((resolve, reject) => {
    zipFile.on('entry', (entry) => {
      if (/\/$/.test(entry.fileName)) {
        zipFile.readEntry();
        return;
      }

      readEntry(zipFile, entry)
        .then((buffer) => {
          entries.set(entry.fileName, buffer);
          zipFile.readEntry();
        })
        .catch(reject);
    });
    zipFile.on('end', () => {
      zipFile.close();
      resolve(entries);
    });
    zipFile.on('error', reject);
    zipFile.readEntry();
  });
}

describe('project export', () => {
  const openHandles: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const handle of openHandles) {
      await handle.close();
    }
    openHandles.length = 0;
  });

  it('packages project metadata, site page list, and latest page artifacts into a zip', async () => {
    const dir = createTempDir('kvault-export-');
    const dbPath = join(dir, 'state.db');
    const storageRoot = join(dir, 'storage');
    const artifactDir = join(storageRoot, 'artifacts', 'run-1', 'page-1');
    mkdirSync(artifactDir, { recursive: true });
    const basePath = join(artifactDir, 'base.md');
    const screenshotPath = join(artifactDir, 'screenshot.png');
    const structuredPath = join(artifactDir, 'structured.json');
    writeFileSync(basePath, '# Base\n\nHello base\n', 'utf8');
    writeFileSync(screenshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(structuredPath, JSON.stringify({ comments: [{ id: 1, body: 'hello' }] }, null, 2), 'utf8');

    const db = await openDatabase(dbPath);
    openHandles.push(db);
    await initializeSchema(db);

    const clock = new SystemClock();
    const projects = new ProjectRepository(db, clock);
    const sites = new SiteRepository(db, clock);
    const runs = new RunRepository(db, clock);
    const pages = new SitePageRepository(db, clock);
    const pageRuns = new PageRunRepository(db, clock);
    const artifactRuns = new ArtifactRunRepository(db, clock);

    const project = await projects.create('Export Project');
    const site = await sites.create({
      projectId: project.id,
      name: 'docs site',
      baseUrl: 'https://www.example.com',
      storageRoot,
      config: createDefaultSiteConfig('https://www.example.com'),
    });
    const skippedSite = await sites.create({
      projectId: project.id,
      name: 'second site',
      baseUrl: 'https://second.example.com',
      storageRoot: join(dir, 'second-storage'),
      config: createDefaultSiteConfig('https://second.example.com'),
    });
    const runId = await runs.createRun({
      siteId: site.id,
      runType: 'crawl_run',
      updatePolicy: 'force_recrawl_all',
      targetSuccessCount: null,
      configSnapshot: site.config,
    });
    const longUrl = `https://www.example.com/blogs/${'very-long-segment-'.repeat(12)}`;
    const sitePageId = await pages.upsertDiscovery({
      siteId: site.id,
      discoveredUrl: longUrl,
      normalizedUrl: longUrl,
      discoverySource: 'seed_url',
      discoveryReferrerUrl: null,
      inventoryStatus: 'discovered_only',
      urlRuleDecision: 'allow',
    });
    const pageRunId = await pageRuns.create({
      runId,
      sitePageId,
      baseCaptureStatus: 'succeeded',
      baseCapturePath: basePath,
      title: 'Long Blog',
      metaDescription: 'Example blog',
      bodyText: 'Hello body',
      classificationLabels: {
        content_type: ['blog'],
      },
      ruleOutcome: 'allow',
      decisionOutcome: 'allow',
      decisionReason: null,
      pendingReason: null,
      requiredArtifacts: ['markdown', 'screenshot', 'structured'],
    });
    await pages.recordBaseCapture({
      sitePageId,
      runId,
      title: 'Long Blog',
      pageOutcome: 'allow',
      requiredArtifacts: ['markdown', 'screenshot', 'structured'],
      pendingReason: null,
    });
    await artifactRuns.create({
      runId,
      pageRunId,
      sitePageId,
      artifactType: 'markdown',
      status: 'succeeded',
      content: '# Markdown\n',
      outputPath: null,
      errorMessage: null,
      meta: null,
    });
    await pages.recordArtifactResult({
      sitePageId,
      runId,
      artifactType: 'markdown',
      status: 'succeeded',
    });
    await artifactRuns.create({
      runId,
      pageRunId,
      sitePageId,
      artifactType: 'screenshot',
      status: 'succeeded',
      content: null,
      outputPath: screenshotPath,
      errorMessage: null,
      meta: null,
    });
    await pages.recordArtifactResult({
      sitePageId,
      runId,
      artifactType: 'screenshot',
      status: 'succeeded',
    });
    await artifactRuns.create({
      runId,
      pageRunId,
      sitePageId,
      artifactType: 'structured',
      status: 'succeeded',
      content: null,
      outputPath: structuredPath,
      errorMessage: null,
      meta: null,
    });
    await pages.recordArtifactResult({
      sitePageId,
      runId,
      artifactType: 'structured',
      status: 'succeeded',
    });
    const deniedUrl = 'https://www.example.com/login';
    await pages.upsertDiscovery({
      siteId: site.id,
      discoveredUrl: deniedUrl,
      normalizedUrl: deniedUrl,
      discoverySource: 'link',
      discoveryReferrerUrl: longUrl,
      inventoryStatus: 'url_rule_denied',
      urlRuleDecision: 'deny',
    });

    const app = await CaptureApp.create({ dbPath });
    openHandles.push(app);
    const outputPath = join(dir, 'export.zip');
    const result = await app.exportProject(project.id, outputPath);
    const entries = await readZipEntries(result.outputPath);

    expect(entries.get('project_info.json')?.toString('utf8')).toContain('Export Project');

    const siteInfoPath = [...entries.keys()].find((path) => path.endsWith('/site_info.json'));
    const pageListPath = [...entries.keys()].find((path) => path.endsWith('/page_list.xlsx'));
    const pageInfoPaths = [...entries.keys()].filter((path) => path.endsWith('/page_info.json'));
    const baseEntryPath = [...entries.keys()].find((path) => path.endsWith('/base.md'));
    const markdownEntryPath = [...entries.keys()].find((path) => path.endsWith('/markdown.md'));
    const screenshotEntryPath = [...entries.keys()].find((path) => path.endsWith('/screenshot.png'));
    const structuredEntryPath = [...entries.keys()].find((path) => path.endsWith('/structured.json'));

    expect(siteInfoPath).toBeTruthy();
    expect(pageListPath).toBeTruthy();
    expect(pageInfoPaths).toHaveLength(1);
    expect(entries.get(baseEntryPath!)?.toString('utf8')).toContain('Hello base');
    expect(entries.get(markdownEntryPath!)?.toString('utf8')).toContain('# Markdown');
    expect(entries.get(screenshotEntryPath!)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(entries.get(structuredEntryPath!)?.toString('utf8')).toContain('"comments"');
    expect(Buffer.byteLength(basename(dirname(baseEntryPath!)), 'utf8')).toBeLessThanOrEqual(120);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      entries.get(pageListPath!)! as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
    const sheet = workbook.getWorksheet('pages');
    expect(sheet?.getRow(2).getCell(3).value).toBe('Example blog');
    expect(sheet?.getRow(2).getCell(4).value).toBe(longUrl);
    expect(sheet?.getRow(2).getCell(23).value).toBe('succeeded');
    expect(sheet?.getRow(3).getCell(4).value).toBe(deniedUrl);
    expect(sheet?.getRow(3).getCell(26).value).toBe('');

    const listOnlyOutputPath = join(dir, 'export-list-only.zip');
    const listOnlyResult = await app.exportProject(project.id, listOnlyOutputPath, {
      siteIds: [site.id],
      artifacts: [],
    });
    const listOnlyEntries = await readZipEntries(listOnlyResult.outputPath);
    const listOnlyProjectInfo = JSON.parse(listOnlyEntries.get('project_info.json')!.toString('utf8')) as {
      exportOptions: { siteIds: number[]; artifacts: string[] };
    };
    expect(listOnlyResult.siteCount).toBe(1);
    expect(listOnlyResult.artifactFileCount).toBe(0);
    expect([...listOnlyEntries.keys()].filter((path) => path.endsWith('/site_info.json'))).toHaveLength(1);
    expect(listOnlyProjectInfo.exportOptions.siteIds).toEqual([site.id]);
    expect(listOnlyProjectInfo.exportOptions.siteIds).not.toContain(skippedSite.id);
    expect([...listOnlyEntries.keys()].some((path) => path.includes('/pages/'))).toBe(false);
    expect([...listOnlyEntries.keys()].some((path) => path.endsWith('/page_info.json'))).toBe(false);
    expect([...listOnlyEntries.keys()].some((path) => path.endsWith('/page_list.xlsx'))).toBe(true);

    const baseOnlyOutputPath = join(dir, 'export-base-only.zip');
    const baseOnlyResult = await app.exportProject(project.id, baseOnlyOutputPath, {
      siteIds: [site.id],
      artifacts: ['base'],
    });
    const baseOnlyEntries = await readZipEntries(baseOnlyResult.outputPath);
    expect(baseOnlyResult.artifactFileCount).toBe(1);
    expect([...baseOnlyEntries.keys()].some((path) => path.endsWith('/base.md'))).toBe(true);
    expect([...baseOnlyEntries.keys()].some((path) => path.endsWith('/markdown.md'))).toBe(false);
    expect([...baseOnlyEntries.keys()].some((path) => path.endsWith('/screenshot.png'))).toBe(false);
    expect([...baseOnlyEntries.keys()].some((path) => path.endsWith('/structured.json'))).toBe(false);
    expect([...baseOnlyEntries.keys()].filter((path) => path.endsWith('/page_info.json'))).toHaveLength(1);

    const withoutDeniedOutputPath = join(dir, 'export-without-denied.zip');
    const withoutDeniedResult = await app.exportProject(project.id, withoutDeniedOutputPath, {
      siteIds: [site.id],
      artifacts: [],
      status: ['stage2_captured', 'base_captured', 'stage2_pending', 'stage2_skipped', 'discovered_only'],
    });
    const withoutDeniedEntries = await readZipEntries(withoutDeniedResult.outputPath);
    const withoutDeniedProjectInfo = JSON.parse(withoutDeniedEntries.get('project_info.json')!.toString('utf8')) as {
      pageCount: number;
      exportOptions: { status: string[] };
    };
    const withoutDeniedPageListPath = [...withoutDeniedEntries.keys()].find((path) => path.endsWith('/page_list.xlsx'));
    const withoutDeniedWorkbook = new ExcelJS.Workbook();
    await withoutDeniedWorkbook.xlsx.load(
      withoutDeniedEntries.get(withoutDeniedPageListPath!)! as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
    const withoutDeniedSheet = withoutDeniedWorkbook.getWorksheet('pages');
    expect(withoutDeniedResult.pageCount).toBe(1);
    expect(withoutDeniedProjectInfo.pageCount).toBe(1);
    expect(withoutDeniedProjectInfo.exportOptions.status).not.toContain('url_rule_denied');
    expect(withoutDeniedSheet?.getRow(2).getCell(4).value).toBe(longUrl);
    expect(withoutDeniedSheet?.getRow(3).getCell(4).value).toBeNull();

    const pageListOutputPath = join(dir, 'site-pages.xlsx');
    const pageListResult = await app.exportSitePageList({
      siteId: site.id,
      outputPath: pageListOutputPath,
      status: 'url_rule_denied',
    });
    const pageListWorkbook = new ExcelJS.Workbook();
    await pageListWorkbook.xlsx.readFile(pageListResult.outputPath);
    const pageListSheet = pageListWorkbook.getWorksheet('pages');
    expect(pageListResult.pageCount).toBe(1);
    expect(pageListSheet?.getRow(2).getCell(4).value).toBe(deniedUrl);
    expect(pageListSheet?.getRow(3).getCell(4).value).toBeNull();

    const pageIdOutputPath = join(dir, 'page-id-export.zip');
    const pageIdResult = await app.exportSitePagesByIds({
      siteId: site.id,
      pageIds: [sitePageId, 999999, sitePageId],
      outputPath: pageIdOutputPath,
      artifacts: ['base', 'markdown', 'structured'],
    });
    const pageIdEntries = await readZipEntries(pageIdResult.outputPath);
    const pageIdPageListPath = [...pageIdEntries.keys()].find((path) => path.endsWith('page_list.xlsx'));

    expect(pageIdResult.requestedPageCount).toBe(2);
    expect(pageIdResult.pageCount).toBe(1);
    expect(pageIdResult.missingPageIds).toEqual([999999]);
    expect(pageIdEntries.get('site_info.json')?.toString('utf8')).toContain('docs site');
    expect(pageIdPageListPath).toBe('page_list.xlsx');
    expect(pageIdEntries.has('export_info.json')).toBe(false);
    expect([...pageIdEntries.keys()].some((path) => path.startsWith('sites/'))).toBe(false);
    expect([...pageIdEntries.keys()].filter((path) => path.endsWith('/page_info.json'))).toHaveLength(1);
    expect([...pageIdEntries.keys()].some((path) => path.endsWith('/base.md'))).toBe(true);
    expect([...pageIdEntries.keys()].some((path) => path.endsWith('/markdown.md'))).toBe(true);
    expect([...pageIdEntries.keys()].some((path) => path.endsWith('/structured.json'))).toBe(true);
    expect([...pageIdEntries.keys()].some((path) => path.endsWith('/screenshot.png'))).toBe(false);
  });
});
