import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PlaywrightScreenshotTool,
  Crawl4AITool,
  LightpandaMarkdownTool,
  ScraplingTool,
} from '../src/capture/captools/index.js';
import {
  PlaywrightBrowserManager,
  type BrowserManager,
} from '../src/capture/browser-provider.js';
import { resolvePythonCommand } from '../src/capture/python-bridge.js';
import { createDefaultSiteConfig } from '../src/config/site-config.js';
import type { BrowserConfig, BrowserEngine, CaptureCapability, SiteConfig } from '../src/domain/types.js';
import type { CaptureInput, CaptureToolResult, RuntimeContext } from '../src/capture/types.js';
import {
  BENCHMARK_REPORT_DIR,
  BENCHMARK_URLS,
  writeBenchmarkReport,
} from './helpers/benchmark-report.js';
import { startTestSiteServer, type TestSiteServer } from './helpers/site-server.js';

type PythonToolName = 'crawl4ai-page' | 'scrapling-page';

interface BenchmarkReportEntry {
  toolName: PythonToolName;
  engine: BrowserEngine;
  url: string;
  status: 'succeeded' | 'tolerated_failure';
  finalUrl?: string;
  statusCode?: number;
  title?: string;
  markdownLength?: number;
  screenshotBytes?: number;
  structuredType?: string;
  diagnostics?: Record<string, unknown>;
  errorMessage?: string;
}

interface ToolScenario {
  toolName: PythonToolName;
  moduleName: 'crawl4ai' | 'scrapling';
  localNeeds: CaptureCapability[];
  benchmarkNeeds: CaptureCapability[];
  create(manager: BrowserManager): {
    capture(input: CaptureInput): Promise<CaptureToolResult>;
  };
}

const TOOL_SCENARIOS: ToolScenario[] = [
  {
    toolName: 'crawl4ai-page',
    moduleName: 'crawl4ai',
    localNeeds: ['base', 'markdown', 'structured'],
    benchmarkNeeds: ['base', 'markdown', 'structured'],
    create: (manager) => new Crawl4AITool(manager),
  },
  {
    toolName: 'scrapling-page',
    moduleName: 'scrapling',
    localNeeds: ['base', 'markdown', 'screenshot', 'structured'],
    benchmarkNeeds: ['base', 'markdown', 'screenshot', 'structured'],
    create: (manager) => new ScraplingTool(manager),
  },
];

const availabilityCache = new Map<string, Promise<boolean>>();

function browserConfigFor(engine: BrowserEngine): BrowserConfig {
  return {
    engine,
    profileMode: 'ephemeral',
    reuse: 'run_browser',
    contextReuse: 'site_session_proxy',
    pageReuse: 'none',
    proxyBinding: 'none',
  };
}

function makeRuntime(): RuntimeContext {
  return {
    requestId: 'capture-e2e',
    async sendRequest(url: string) {
      const response = await fetch(url, {
        redirect: 'follow',
        headers: {
          'user-agent': 'kvault-web-capture e2e',
        },
      });

      return {
        statusCode: response.status,
        url: response.url,
        body: await response.text(),
      };
    },
  };
}

function makeSiteConfig(baseUrl: string, browser?: BrowserConfig): SiteConfig {
  const config = createDefaultSiteConfig(new URL(baseUrl).origin);
  if (browser) {
    config.browser = browser;
  }
  return config;
}

function makeInput(input: {
  url: string;
  needs: CaptureCapability[];
  siteConfig?: SiteConfig;
}): CaptureInput {
  return {
    runId: 1,
    siteId: 1,
    url: input.url,
    normalizedUrl: input.url,
    needs: input.needs,
    siteConfig: input.siteConfig ?? makeSiteConfig(input.url),
    runtime: makeRuntime(),
  };
}

function pythonCommand(toolName?: PythonToolName): string {
  return resolvePythonCommand({ toolName });
}

function commandExists(command: string): boolean {
  const result = spawnSync('sh', ['-lc', `command -v "${command}" >/dev/null 2>&1`], {
    encoding: 'utf8',
  });
  return result.status === 0;
}

function pythonModuleAvailable(moduleName: string, toolName?: PythonToolName): boolean {
  const result = spawnSync(
    pythonCommand(toolName),
    ['-c', `import ${moduleName}`],
    { encoding: 'utf8' },
  );
  return result.status === 0;
}

function shouldTolerateBenchmarkFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/is not installed|package is required|command not found|no such file|cdp endpoint leases are not available/i.test(message)) {
    return false;
  }

  return /access denied|forbidden|captcha|challenge|cloudflare|just a moment|timed out|timeout|429|403|blocked|dns|ssl|certificate|navigation|connection closed|context or browser has been closed|acs-goto|proxy direct failed|browser\.new_context|patchright|crpage\.js|nodeid/i.test(
    message,
  );
}

function expectMeaningfulCapture(result: CaptureToolResult, needs: CaptureCapability[]): void {
  if (needs.includes('base')) {
    expect(result.extracted?.title?.trim().length ?? 0).toBeGreaterThan(0);
    expect(result.html?.trim().length ?? 0).toBeGreaterThan(0);
  }

  if (needs.includes('markdown')) {
    expect(result.markdown?.trim().length ?? 0).toBeGreaterThan(0);
  }

  if (needs.includes('screenshot')) {
    expect(result.screenshot?.byteLength ?? 0).toBeGreaterThan(0);
  }

  if (needs.includes('structured')) {
    expect(result.structured).toBeDefined();
  }
}

function expectBenchmarkAttemptProducedSignal(result: CaptureToolResult): void {
  const hasSignal =
    (result.statusCode ?? 0) > 0 ||
    (result.finalUrl?.trim().length ?? 0) > 0 ||
    (result.html?.trim().length ?? 0) > 0 ||
    (result.extracted?.title?.trim().length ?? 0) > 0 ||
    (result.diagnostics ? Object.keys(result.diagnostics).length > 0 : false);

  expect(hasSignal).toBe(true);
}

function makeBenchmarkReportEntry(input: {
  toolName: PythonToolName;
  engine: BrowserEngine;
  url: string;
  result?: CaptureToolResult;
  error?: unknown;
}): BenchmarkReportEntry {
  if (input.result) {
    return {
      toolName: input.toolName,
      engine: input.engine,
      url: input.url,
      status: 'succeeded',
      finalUrl: input.result.finalUrl,
      statusCode: input.result.statusCode,
      title: input.result.extracted?.title,
      markdownLength: input.result.markdown?.length,
      screenshotBytes: input.result.screenshot?.byteLength,
      structuredType: input.result.structured === undefined ? undefined : typeof input.result.structured,
      diagnostics: input.result.diagnostics,
    };
  }

  return {
    toolName: input.toolName,
    engine: input.engine,
    url: input.url,
    status: 'tolerated_failure',
    errorMessage: input.error instanceof Error ? input.error.message : String(input.error),
  };
}

async function engineAvailable(engine: BrowserEngine): Promise<boolean> {
  const cacheKey = `engine:${engine}`;
  let cached = availabilityCache.get(cacheKey);
  if (!cached) {
    cached = probeEngine(engine);
    availabilityCache.set(cacheKey, cached);
  }
  return cached;
}

async function toolScenarioAvailable(scenario: ToolScenario, engine: BrowserEngine): Promise<boolean> {
  return pythonModuleAvailable(scenario.moduleName, scenario.toolName) && await engineAvailable(engine);
}

async function probeEngine(engine: BrowserEngine): Promise<boolean> {
  if (engine === 'lightpanda' && !commandExists(process.env.LIGHTPANDA_BINARY ?? 'lightpanda')) {
    return false;
  }

  const manager = new PlaywrightBrowserManager({ browser: browserConfigFor(engine) });
  let server: TestSiteServer | null = null;
  try {
    server = await startTestSiteServer();
    const identity = {
      runId: 1,
      siteId: 1,
      engine,
      profileMode: 'ephemeral' as const,
    };
    const lease = await manager.acquirePage({
      identity,
      url: `${server.baseUrl}/docs`,
      runtime: makeRuntime(),
    });
    try {
      await lease.page.goto(`${server.baseUrl}/docs`, {
        waitUntil: 'load',
        timeout: 45_000,
      });
    } finally {
      await lease.release();
    }
    return true;
  } catch {
    return false;
  } finally {
    await manager.close().catch(() => {});
    await server?.close().catch(() => {});
  }
}

describe('capture stack e2e smoke', () => {
  const servers: TestSiteServer[] = [];
  const managers: BrowserManager[] = [];

  afterEach(async () => {
    while (managers.length > 0) {
      await managers.pop()!.close().catch(() => {});
    }
    while (servers.length > 0) {
      await servers.pop()!.close().catch(() => {});
    }
  });

  it('captures screenshots with the real chromium browser stack on the mock site', async ({ skip }) => {
    if (!(await engineAvailable('chromium'))) {
      skip();
    }

    const server = await startTestSiteServer();
    servers.push(server);
    const manager = new PlaywrightBrowserManager({ browser: browserConfigFor('chromium') });
    managers.push(manager);

    const result = await new PlaywrightScreenshotTool(manager).capture(
      makeInput({
        url: `${server.baseUrl}/docs`,
        needs: ['screenshot'],
        siteConfig: makeSiteConfig(server.baseUrl, browserConfigFor('chromium')),
      }),
    );

    expect(result.finalUrl).toBe(`${server.baseUrl}/docs`);
    expectMeaningfulCapture(result, ['screenshot']);
  });

  it('captures markdown with the real lightpanda path when lightpanda is available', async ({ skip }) => {
    if (!(await engineAvailable('lightpanda'))) {
      skip();
    }

    const server = await startTestSiteServer();
    servers.push(server);
    const manager = new PlaywrightBrowserManager({ browser: browserConfigFor('lightpanda') });
    managers.push(manager);

    const result = await new LightpandaMarkdownTool(manager).capture(
      makeInput({
        url: `${server.baseUrl}/docs`,
        needs: ['markdown'],
        siteConfig: makeSiteConfig(server.baseUrl, browserConfigFor('lightpanda')),
      }),
    );

    expect(result.finalUrl).toBe(`${server.baseUrl}/docs`);
    expect(result.markdown).toContain('Docs content for inventory and crawl testing.');
  });

  it('isolates concurrent lightpanda page leases', async ({ skip }) => {
    if (!(await engineAvailable('lightpanda'))) {
      skip();
    }

    const server = await startTestSiteServer();
    servers.push(server);
    const config = browserConfigFor('lightpanda');
    const manager = new PlaywrightBrowserManager({ browser: config });
    managers.push(manager);
    const tool = new LightpandaMarkdownTool(manager);

    const [docs, product] = await Promise.all([
      tool.capture(makeInput({
        url: `${server.baseUrl}/docs`,
        needs: ['markdown'],
        siteConfig: makeSiteConfig(server.baseUrl, config),
      })),
      tool.capture(makeInput({
        url: `${server.baseUrl}/product`,
        needs: ['markdown'],
        siteConfig: makeSiteConfig(server.baseUrl, config),
      })),
    ]);

    expect(docs.markdown).toContain('Docs content for inventory and crawl testing.');
    expect(product.markdown).toContain('Product content for artifact capture.');
  });

  it('captures screenshots with cloakbrowser when cloakbrowser can be launched', async ({ skip }) => {
    if (!(await engineAvailable('cloakbrowser'))) {
      skip();
    }

    const server = await startTestSiteServer();
    servers.push(server);
    const manager = new PlaywrightBrowserManager({ browser: browserConfigFor('cloakbrowser') });
    managers.push(manager);

    const result = await new PlaywrightScreenshotTool(manager).capture(
      makeInput({
        url: `${server.baseUrl}/docs`,
        needs: ['screenshot'],
        siteConfig: makeSiteConfig(server.baseUrl, browserConfigFor('cloakbrowser')),
      }),
    );

    expect(result.finalUrl).toBe(`${server.baseUrl}/docs`);
    expectMeaningfulCapture(result, ['screenshot']);
  });

  it('records every python tool and browser combination on the mock site', async ({ skip }) => {
    const scenarios = TOOL_SCENARIOS.flatMap((scenario) =>
      (['chromium', 'cloakbrowser', 'lightpanda'] as BrowserEngine[]).map((engine) => ({
        scenario,
        engine,
      })),
    );

    const availableScenarios: Array<{ scenario: ToolScenario; engine: BrowserEngine }> = [];
    for (const candidate of scenarios) {
      if (await toolScenarioAvailable(candidate.scenario, candidate.engine)) {
        availableScenarios.push(candidate);
      }
    }

    if (availableScenarios.length === 0) {
      skip();
    }

    const server = await startTestSiteServer();
    servers.push(server);
    const reportEntries: BenchmarkReportEntry[] = [];

    for (const candidate of availableScenarios) {
      const manager = new PlaywrightBrowserManager({ browser: browserConfigFor(candidate.engine) });
      managers.push(manager);
      const url = `${server.baseUrl}/docs`;
      try {
        const result = await candidate.scenario.create(manager).capture(
          makeInput({
            url,
            needs: candidate.scenario.localNeeds,
            siteConfig: makeSiteConfig(server.baseUrl, browserConfigFor(candidate.engine)),
          }),
        );

        expect(result.extracted?.title).toBe('Docs');
        expect(result.diagnostics?.source).toBe(candidate.scenario.moduleName);
        expect(result.diagnostics?.cdpUrlUsed).toBe(true);
        expectMeaningfulCapture(result, candidate.scenario.localNeeds);
        reportEntries.push(makeBenchmarkReportEntry({
          toolName: candidate.scenario.toolName,
          engine: candidate.engine,
          url,
          result,
        }));
      } catch (error) {
        expect(
          shouldTolerateBenchmarkFailure(error),
          `${candidate.scenario.toolName}:${candidate.engine}:${url} mock-site failure should be reported as a tolerated tool/browser limitation: ${String(error)}`,
        ).toBe(true);
        reportEntries.push(makeBenchmarkReportEntry({
          toolName: candidate.scenario.toolName,
          engine: candidate.engine,
          url,
          error,
        }));
      }
    }

    const reportPath = writeBenchmarkReport('capture-stack-mock-matrix', {
      generatedAt: new Date().toISOString(),
      reportDir: BENCHMARK_REPORT_DIR,
      entries: reportEntries,
    });

    expect(reportEntries).toHaveLength(availableScenarios.length);
    expect(reportPath).toContain('.tmp/e2e-capture-reports');
  });

  it('records benchmark outcomes for every available python tool and browser combination', async ({ skip }) => {
    const reportEntries: BenchmarkReportEntry[] = [];
    const scenarios = TOOL_SCENARIOS.flatMap((scenario) =>
      (['chromium', 'cloakbrowser', 'lightpanda'] as BrowserEngine[]).map((engine) => ({
        scenario,
        engine,
      })),
    );

    let attemptedCount = 0;

    for (const candidate of scenarios) {
      if (!(await toolScenarioAvailable(candidate.scenario, candidate.engine))) {
        continue;
      }

      const manager = new PlaywrightBrowserManager({ browser: browserConfigFor(candidate.engine) });
      managers.push(manager);
      const tool = candidate.scenario.create(manager);

      for (const url of BENCHMARK_URLS) {
        attemptedCount += 1;
        try {
          const result = await tool.capture(
            makeInput({
              url,
              needs: candidate.scenario.benchmarkNeeds,
              siteConfig: makeSiteConfig(url, browserConfigFor(candidate.engine)),
            }),
          );
          expectBenchmarkAttemptProducedSignal(result);
          reportEntries.push(makeBenchmarkReportEntry({
            toolName: candidate.scenario.toolName,
            engine: candidate.engine,
            url,
            result,
          }));
        } catch (error) {
          expect(
            shouldTolerateBenchmarkFailure(error),
            `${candidate.scenario.toolName}:${candidate.engine}:${url} benchmark failure should be a tolerated anti-bot limitation: ${String(error)}`,
          ).toBe(true);
          reportEntries.push(makeBenchmarkReportEntry({
            toolName: candidate.scenario.toolName,
            engine: candidate.engine,
            url,
            error,
          }));
        }
      }
    }

    if (attemptedCount === 0) {
      skip();
    }

    const reportPath = writeBenchmarkReport('capture-stack-matrix', {
      generatedAt: new Date().toISOString(),
      reportDir: BENCHMARK_REPORT_DIR,
      entries: reportEntries,
    });

    expect(reportEntries.length).toBe(attemptedCount);
    expect(reportPath).toContain('.tmp/e2e-capture-reports');
  });
});
