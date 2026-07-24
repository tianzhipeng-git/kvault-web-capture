import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RequestQueue } from 'crawlee';
import { afterEach, describe, expect, it } from 'vitest';

import { PageCaptureExecutor } from '../src/capture/executor.js';
import type { CaptureInput, CaptureTool, CaptureToolResult, RuntimeContext } from '../src/capture/types.js';
import { FakeClassifier } from '../src/classification/fake-classifier.js';
import { createDefaultSiteConfig } from '../src/config/site-config.js';
import { createPageCaptureRequestHandler } from '../src/crawlee/handlers.js';
import { initializeSchema, openDatabase, type DbClient } from '../src/db/database.js';
import {
  ArtifactRunRepository,
  PageRunRepository,
  ProjectRepository,
  RunLogRepository,
  RunRepository,
  SitePageRepository,
  SiteRepository,
} from '../src/db/repositories/index.js';
import type { PageCaptureTask, SiteConfig } from '../src/domain/types.js';
import { FileArtifactWriter } from '../src/export/file-artifact-writer.js';
import type { RunPlanner } from '../src/planner/run-planner.js';
import { SystemClock } from '../src/utils/clock.js';
import { createTempDir } from './helpers/tmp.js';

class FullCaptureTool implements CaptureTool {
  readonly name = 'full-capture';
  readonly capabilities = ['base', 'markdown', 'structured'] as const;

  readonly calls: CaptureInput[] = [];

  async capture(input: CaptureInput): Promise<CaptureToolResult> {
    this.calls.push(input);
    return {
      toolName: this.name,
      statusCode: 200,
      html: '<html><head><title>Docs</title></head><body>Docs body</body></html>',
      extracted: {
        url: input.url,
        normalizedUrl: input.normalizedUrl,
        title: 'Docs',
        metaDescription: 'Docs page',
        bodyText: 'Docs body',
        links: [],
      },
      markdown: '# Docs\n\nDocs body\n',
      markdownToolName: this.name,
      structured: {
        title: 'Docs',
        items: [{ id: 1, text: 'Docs body' }],
      },
    };
  }
}

const runtime: RuntimeContext = {
  requestId: 'full-capture-test',
  sendRequest: async () => {
    throw new Error('not used');
  },
};

function makeSiteConfig(baseUrl: string): SiteConfig {
  return {
    ...createDefaultSiteConfig(baseUrl),
    rulesBeforeStage2Eq: [
      {
        name: 'allow-docs',
        matchType: 'label',
        listType: 'whitelist',
        when: [{ key: 'content_type', op: 'any_of', values: ['docs'] }],
        artifacts: ['markdown', 'structured'],
      },
    ],
    runOptions: {
      seedMaxDepth: 0,
      crawlMaxDepth: 0,
      maxRequestRetries: 3,
    },
  };
}

function makeNoopPlanner(): RunPlanner {
  return {
    planRequest: async () => ({
      siteId: 1,
      sitePageId: 1,
      normalizedUrl: 'https://example.com/unused',
      enqueue: false,
      urlRuleDecision: 'allow',
      planReason: null,
    }),
  } as unknown as RunPlanner;
}

function makeQueue(): { queue: RequestQueue; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    queue: {
      addRequest: async (request: unknown) => {
        calls.push(request);
        return { wasAlreadyPresent: false };
      },
    } as unknown as RequestQueue,
  };
}

describe('full page-capture task integration', () => {
  const dbs: DbClient[] = [];

  afterEach(async () => {
    while (dbs.length > 0) {
      await dbs.pop()!.close();
    }
  });

  it('persists base and already-returned artifacts from one base task without enqueueing artifact tasks', async () => {
    const dir = createTempDir('kvault-full-capture-');
    const db = await openDatabase({ path: join(dir, 'state.db') });
    dbs.push(db);
    await initializeSchema(db);

    const clock = new SystemClock();
    const projects = new ProjectRepository(db, clock);
    const sites = new SiteRepository(db, clock);
    const runs = new RunRepository(db, clock);
    const sitePages = new SitePageRepository(db, clock);
    const pageRuns = new PageRunRepository(db, clock);
    const artifactRuns = new ArtifactRunRepository(db, clock);
    const runLogs = new RunLogRepository(db, clock);

    const baseUrl = 'https://example.com';
    const siteConfig = makeSiteConfig(baseUrl);
    const project = await projects.create('Full Capture Project');
    const site = await sites.create({
      projectId: project.id,
      name: 'full-capture-site',
      baseUrl,
      storageRoot: join(dir, 'storage'),
      config: siteConfig,
    });
    const runId = await runs.createRun({
      siteId: site.id,
      runType: 'crawl_run',
      updatePolicy: 'force_recrawl_all',
      targetSuccessCount: null,
      configSnapshot: siteConfig,
    });
    const sitePageId = await sitePages.upsertDiscovery({
      siteId: site.id,
      discoveredUrl: `${baseUrl}/docs`,
      normalizedUrl: `${baseUrl}/docs`,
      discoverySource: 'seed',
      discoveryReferrerUrl: null,
      inventoryStatus: 'discovered_only',
      urlRuleDecision: 'allow',
    });

    const tool = new FullCaptureTool();
    const { queue, calls: enqueueCalls } = makeQueue();
    const handler = createPageCaptureRequestHandler({
      executor: new PageCaptureExecutor([tool]),
      classifier: new FakeClassifier(),
      siteConfig,
      runType: 'crawl_run',
      updatePolicy: 'force_recrawl_all',
      staleAfterMs: null,
      pageCaptureQueue: queue,
      artifactWriter: new FileArtifactWriter(site.storageRoot),
      artifactRunRepository: artifactRuns,
      pageRunRepository: pageRuns,
      sitePageRepository: sitePages,
      runPlanner: makeNoopPlanner(),
      captureTools: [tool],
      runLog: runLogs,
    });

    const task: PageCaptureTask = {
      stage: 'page_capture',
      runId,
      siteId: site.id,
      sitePageId,
      normalizedUrl: `${baseUrl}/docs`,
      url: `${baseUrl}/docs`,
      depth: 0,
      needs: ['base', 'markdown', 'structured'],
      purpose: 'discovery',
    };

    await handler({ task, runtime });

    const pageRunRows = await db.all<{
      id: number;
      decision_outcome: string;
      required_artifacts_json: string;
      base_capture_path: string;
    }>('SELECT id, decision_outcome, required_artifacts_json, base_capture_path FROM page_runs', []);
    const artifactRows = await db.all<{
      artifact_type: string;
      status: string;
      output_path: string;
      content: string;
      page_run_id: number;
    }>('SELECT artifact_type, status, output_path, content, page_run_id FROM artifact_runs ORDER BY artifact_type', []);
    const sitePageRow = await db.get<{
      inventory_status: string;
      last_base_status: string | null;
      last_markdown_status: string | null;
      last_structured_status: string | null;
    }>(
      `SELECT inventory_status, last_base_status, last_markdown_status, last_structured_status
       FROM site_pages
       WHERE id = ?`,
      [sitePageId],
    );

    expect(tool.calls).toHaveLength(1);
    expect(tool.calls[0].needs).toEqual(['base', 'markdown', 'structured']);
    expect(enqueueCalls).toHaveLength(0);
    expect(pageRunRows).toHaveLength(1);
    expect(pageRunRows[0].decision_outcome).toBe('allow');
    expect(JSON.parse(pageRunRows[0].required_artifacts_json)).toEqual([
      { artifactType: 'markdown', variantKey: 'default', configFingerprint: null },
      { artifactType: 'structured', variantKey: 'default', configFingerprint: null },
    ]);
    expect(existsSync(pageRunRows[0].base_capture_path)).toBe(true);

    expect(artifactRows).toEqual([
      {
        artifact_type: 'markdown',
        status: 'succeeded',
        output_path: expect.stringContaining('markdown.md'),
        content: '# Docs\n\nDocs body\n',
        page_run_id: pageRunRows[0].id,
      },
      {
        artifact_type: 'structured',
        status: 'succeeded',
        output_path: expect.stringContaining('structured.json'),
        content: '{\n  "title": "Docs",\n  "items": [\n    {\n      "id": 1,\n      "text": "Docs body"\n    }\n  ]\n}\n',
        page_run_id: pageRunRows[0].id,
      },
    ]);
    expect(readFileSync(artifactRows[1].output_path, 'utf8')).toContain('"items"');
    expect(sitePageRow).toEqual({
      inventory_status: 'stage2_captured',
      last_base_status: 'succeeded',
      last_markdown_status: 'succeeded',
      last_structured_status: 'succeeded',
    });
  });
});
