import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CaptureApp } from '../src/app/capture-app.js';
import { openDatabase } from '../src/db/database.js';
import type { ArtifactType, BrowserEngine } from '../src/domain/types.js';
import {
  BENCHMARK_REPORT_DIR,
  BENCHMARK_URLS,
  writeBenchmarkReport,
} from './helpers/benchmark-report.js';
import { createTempDir } from './helpers/tmp.js';

interface AppBenchmarkScenario {
  name: string;
  browserEngine: BrowserEngine;
  tools: string[];
  screenshotMinBytes?: number;
}

interface AppRunReport {
  scenarioName: string;
  url: string;
  storageRoot: string;
  runtimeLogRelativePath: string | null;
  runSummary: {
    runId: number;
    siteId: number;
    sitePageId: number;
    normalizedUrl: string;
    pageRuns: number;
    artifactRuns: number;
  };
  basePageDone: boolean;
  basePageFailed: boolean;
  baseDiagnostics: unknown[];
  artifactRows: Array<{
    artifactType: string;
    status: string;
    errorMessage: string | null;
    outputPath: string | null;
  }>;
  logRows: Array<{
    event: string;
    message: string;
    meta: Record<string, unknown> | null;
  }>;
  sitePage: {
    inventoryStatus: string;
    lastBaseStatus: string | null;
    lastMarkdownStatus: string | null;
    lastScreenshotStatus: string | null;
    lastStructuredStatus: string | null;
  } | null;
}

function writeBenchmarkSiteConfig(input: {
  configPath: string;
  url: string;
  browserEngine: BrowserEngine;
  tools: string[];
  requiredArtifacts: ArtifactType[];
  screenshotMinBytes?: number;
}): void {
  writeFileSync(
    input.configPath,
    JSON.stringify(
      {
        seedUrls: [input.url],
        sitemaps: [],
        rulesBeforeBaseEq: [],
        rulesBeforeStage2Eq: [
          {
            name: 'allow-benchmark-pages',
            matchType: 'label',
            listType: 'whitelist',
            when: [{ key: 'content_type', op: 'any_of', values: ['generic', 'docs', 'product'] }],
            artifacts: input.requiredArtifacts,
          },
        ],
        runOptions: { seedMaxDepth: 0, crawlMaxDepth: 0 },
        browser: {
          engine: input.browserEngine,
          profileMode: 'ephemeral',
          reuse: 'run_browser',
          contextReuse: 'site_session_proxy',
          pageReuse: 'none',
          proxyBinding: 'none',
        },
        captureProfiles: {
          default: {
            tools: input.tools,
            validation: input.screenshotMinBytes === undefined
              ? undefined
              : {
                  screenshot: {
                    minBytes: input.screenshotMinBytes,
                  },
                },
          },
        },
        defaultCaptureProfile: 'default',
        validation: {
          base: {
            rejectRegex: ['Access Denied', 'Just a moment', 'verify you are human'],
          },
          markdown: {
            minLength: 1,
            rejectRegex: ['Access Denied', 'Just a moment', 'verify you are human'],
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );
}

async function runBenchmarkAppScenario(input: {
  scenario: AppBenchmarkScenario;
  url: string;
}): Promise<AppRunReport> {
  const dir = createTempDir(`kvault-benchmark-${input.scenario.name}-`);
  const dbPath = join(dir, 'state.db');
  const storageRoot = join(dir, 'storage');
  const app = await CaptureApp.create({ dbPath });

  try {
    const project = await app.createProject(`benchmark-${input.scenario.name}`);
    const site = await app.createSite({
      projectSlug: project.slug,
      name: input.scenario.name,
      baseUrl: new URL(input.url).origin,
      storageRoot,
    });
    const configPath = join(dir, 'site-config.json');
    writeBenchmarkSiteConfig({
      configPath,
      url: input.url,
      browserEngine: input.scenario.browserEngine,
      tools: input.scenario.tools,
      requiredArtifacts: ['markdown', 'structured', 'screenshot'],
      screenshotMinBytes: input.scenario.screenshotMinBytes,
    });
    await app.importSiteConfig(site.id, configPath);

    const runSummary = await app.runCrawl({
      siteId: site.id,
      updatePolicy: 'force_recrawl_all',
      targetSuccessCount: null,
      staleAfterMs: null,
    });

    const db = await openDatabase(dbPath);
    try {
      const logRows = await db.all<{
        event: string;
        message: string;
        meta_json: string | null;
      }>(
        `SELECT event, message, meta_json
         FROM run_logs
         WHERE crawl_run_id = ?
         ORDER BY id`,
        [runSummary.runId],
      );
      const artifactRows = await db.all<{
        artifact_type: string;
        status: string;
        error_message: string | null;
        output_path: string | null;
      }>(
        `SELECT artifact_type, status, error_message, output_path
         FROM artifact_runs
         WHERE crawl_run_id = ?
         ORDER BY id`,
        [runSummary.runId],
      );
      const sitePage = await db.get<{
        inventory_status: string;
        last_base_status: string | null;
        last_markdown_status: string | null;
        last_screenshot_status: string | null;
        last_structured_status: string | null;
      }>(
        `SELECT inventory_status, last_base_status, last_markdown_status, last_screenshot_status, last_structured_status
         FROM site_pages
         WHERE site_id = ? AND normalized_url = ?`,
        [site.id, input.url],
      );

      const parsedLogs = logRows.map((row) => ({
        event: row.event,
        message: row.message,
        meta: row.meta_json ? JSON.parse(row.meta_json) as Record<string, unknown> : null,
      }));
      const runtimeLogReady = parsedLogs.find((row) => row.event === 'runtime_log_ready');
      const baseDone = parsedLogs.find((row) => row.event === 'base_page_done');
      const baseFailed = parsedLogs.find((row) => row.event === 'base_page_failed');

      return {
        scenarioName: input.scenario.name,
        url: input.url,
        storageRoot,
        runtimeLogRelativePath: typeof runtimeLogReady?.meta?.relativePath === 'string'
          ? runtimeLogReady.meta.relativePath
          : null,
        runSummary,
        basePageDone: baseDone !== undefined,
        basePageFailed: baseFailed !== undefined,
        baseDiagnostics: Array.isArray(baseDone?.meta?.diagnostics) ? baseDone.meta.diagnostics : [],
        artifactRows: artifactRows.map((row) => ({
          artifactType: row.artifact_type,
          status: row.status,
          errorMessage: row.error_message,
          outputPath: row.output_path,
        })),
        logRows: parsedLogs,
        sitePage: sitePage
          ? {
              inventoryStatus: sitePage.inventory_status,
              lastBaseStatus: sitePage.last_base_status,
              lastMarkdownStatus: sitePage.last_markdown_status,
              lastScreenshotStatus: sitePage.last_screenshot_status,
              lastStructuredStatus: sitePage.last_structured_status,
            }
          : null,
      };
    } finally {
      await db.close();
    }
  } finally {
    await app.close();
  }
}

describe('app benchmark e2e capture', () => {
  const reportPaths: string[] = [];

  afterEach(() => {
    expect(reportPaths.every((path) => path.includes('.tmp/e2e-capture-reports'))).toBe(true);
  });

  it('runs BENCHMARK_URLS from CaptureApp with a crawl4ai-first capture profile over chromium', async () => {
    const scenario: AppBenchmarkScenario = {
      name: 'crawl4ai-first-chromium',
      browserEngine: 'chromium',
      tools: [
        'crawl4ai-page',
        'scrapling-page',
        'http-base',
        'defuddle-markdown',
        'lightpanda-markdown',
        'playwright-screenshot',
      ],
    };

    const reports: AppRunReport[] = [];
    for (const url of BENCHMARK_URLS) {
      reports.push(await runBenchmarkAppScenario({ scenario, url }));
    }

    const reportPath = writeBenchmarkReport('app-benchmark-crawl4ai-first-chromium', {
      generatedAt: new Date().toISOString(),
      reportDir: BENCHMARK_REPORT_DIR,
      reports,
    });
    reportPaths.push(reportPath);

    expect(reports).toHaveLength(BENCHMARK_URLS.length);
    expect(reports.every((report) => report.runtimeLogRelativePath !== null)).toBe(true);
    expect(reports.every((report) => report.basePageDone || report.basePageFailed)).toBe(true);
    expect(reports.some((report) => report.basePageDone && report.baseDiagnostics.length > 0)).toBe(true);
  }, 360_000);

  it('runs BENCHMARK_URLS from CaptureApp with a scrapling-first capture profile over lightpanda', async () => {
    const scenario: AppBenchmarkScenario = {
      name: 'scrapling-first-lightpanda',
      browserEngine: 'lightpanda',
      tools: [
        'scrapling-page',
        'crawl4ai-page',
        'http-base',
        'defuddle-markdown',
        'lightpanda-markdown',
        'playwright-screenshot',
      ],
    };

    const reports: AppRunReport[] = [];
    for (const url of BENCHMARK_URLS) {
      reports.push(await runBenchmarkAppScenario({ scenario, url }));
    }

    const reportPath = writeBenchmarkReport('app-benchmark-scrapling-first-lightpanda', {
      generatedAt: new Date().toISOString(),
      reportDir: BENCHMARK_REPORT_DIR,
      reports,
    });
    reportPaths.push(reportPath);

    expect(reports).toHaveLength(BENCHMARK_URLS.length);
    expect(reports.every((report) => report.runtimeLogRelativePath !== null)).toBe(true);
    expect(reports.every((report) => report.basePageDone || report.basePageFailed)).toBe(true);
    expect(reports.some((report) => report.basePageDone && report.baseDiagnostics.length > 0)).toBe(true);
  }, 360_000);

  it('exercises capture profile fallback and ResultValidator end-to-end by forcing screenshot rejection', async () => {
    const scenario: AppBenchmarkScenario = {
      name: 'validator-forced-screenshot-failure',
      browserEngine: 'chromium',
      tools: [
        'crawl4ai-page',
        'scrapling-page',
        'http-base',
        'defuddle-markdown',
        'lightpanda-markdown',
        'playwright-screenshot',
      ],
      screenshotMinBytes: 50_000_000,
    };

    const report = await runBenchmarkAppScenario({
      scenario,
      url: BENCHMARK_URLS[0],
    });

    const reportPath = writeBenchmarkReport('app-benchmark-validator-forced-screenshot-failure', {
      generatedAt: new Date().toISOString(),
      reportDir: BENCHMARK_REPORT_DIR,
      report,
    });
    reportPaths.push(reportPath);

    expect(report.basePageDone).toBe(true);
    const failedScreenshot = report.artifactRows.find((row) => row.artifactType === 'screenshot' && row.status === 'failed');
    expect(failedScreenshot).toBeDefined();
    expect(failedScreenshot?.errorMessage).toContain('screenshot is below');
    expect(failedScreenshot?.errorMessage).toContain('playwright-screenshot');
    expect(report.logRows.some((row) => row.event === 'artifact_failed' && row.message.includes('[screenshot] FAILED'))).toBe(true);
  }, 360_000);
});
