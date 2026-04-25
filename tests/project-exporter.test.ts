import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';
import yauzl from 'yauzl';

import { M1App } from '../src/app/services.js';
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
  const openHandles: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const handle of openHandles) {
      handle.close();
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
    writeFileSync(basePath, '# Base\n\nHello base\n', 'utf8');
    writeFileSync(screenshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const db = openDatabase(dbPath);
    openHandles.push(db);
    initializeSchema(db);

    const clock = new SystemClock();
    const projects = new ProjectRepository(db, clock);
    const sites = new SiteRepository(db, clock);
    const runs = new RunRepository(db, clock);
    const pages = new SitePageRepository(db, clock);
    const pageRuns = new PageRunRepository(db, clock);
    const artifactRuns = new ArtifactRunRepository(db, clock);

    const project = projects.create('Export Project');
    const site = sites.create({
      projectId: project.id,
      name: 'docs site',
      baseUrl: 'https://www.example.com',
      storageRoot,
      config: createDefaultSiteConfig('https://www.example.com'),
    });
    const runId = runs.createRun({
      siteId: site.id,
      runType: 'crawl_run',
      updatePolicy: 'force_recrawl_all',
      targetSuccessCount: null,
      configSnapshot: site.config,
    });
    const longUrl = `https://www.example.com/blogs/${'very-long-segment-'.repeat(12)}`;
    const sitePageId = pages.upsertDiscovery({
      siteId: site.id,
      discoveredUrl: longUrl,
      normalizedUrl: longUrl,
      discoverySource: 'seed_url',
      discoveryReferrerUrl: null,
      inventoryStatus: 'discovered_only',
      urlRuleDecision: 'allow',
    });
    const pageRunId = pageRuns.create({
      runId,
      sitePageId,
      baseCaptureStatus: 'succeeded',
      baseCapturePath: basePath,
      title: 'Long Blog',
      metaDescription: 'Example blog',
      bodyText: 'Hello body',
      classificationTags: {
        content_type: ['blog'],
      },
      ruleOutcome: 'allow',
      decisionOutcome: 'allow',
      decisionReason: null,
      pendingReason: null,
      requiredArtifacts: ['markdown', 'screenshot'],
    });
    pages.recordBaseCapture({
      sitePageId,
      runId,
      title: 'Long Blog',
      pageOutcome: 'allow',
      requiredArtifacts: ['markdown', 'screenshot'],
      pendingReason: null,
    });
    artifactRuns.create({
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
    pages.recordArtifactResult({
      sitePageId,
      runId,
      artifactType: 'markdown',
      status: 'succeeded',
    });
    artifactRuns.create({
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
    pages.recordArtifactResult({
      sitePageId,
      runId,
      artifactType: 'screenshot',
      status: 'succeeded',
    });
    const deniedUrl = 'https://www.example.com/login';
    pages.upsertDiscovery({
      siteId: site.id,
      discoveredUrl: deniedUrl,
      normalizedUrl: deniedUrl,
      discoverySource: 'link',
      discoveryReferrerUrl: longUrl,
      inventoryStatus: 'url_rule_denied',
      urlRuleDecision: 'deny',
    });

    const app = new M1App({ dbPath });
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

    expect(siteInfoPath).toBeTruthy();
    expect(pageListPath).toBeTruthy();
    expect(pageInfoPaths).toHaveLength(1);
    expect(entries.get(baseEntryPath!)?.toString('utf8')).toContain('Hello base');
    expect(entries.get(markdownEntryPath!)?.toString('utf8')).toContain('# Markdown');
    expect(entries.get(screenshotEntryPath!)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(Buffer.byteLength(basename(dirname(baseEntryPath!)), 'utf8')).toBeLessThanOrEqual(120);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      entries.get(pageListPath!)! as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
    const sheet = workbook.getWorksheet('pages');
    expect(sheet?.getRow(2).getCell(3).value).toBe(longUrl);
    expect(sheet?.getRow(3).getCell(3).value).toBe(deniedUrl);
    expect(sheet?.getRow(3).getCell(25).value).toBe('');
  });
});
