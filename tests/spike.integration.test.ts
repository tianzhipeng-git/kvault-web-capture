import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { Configuration, RequestQueue } from 'crawlee';
import { describe, expect, it } from 'vitest';

import { FileArtifactWriter } from '../src/export/file-artifact-writer.js';
import { FakeClassifier } from '../src/classification/fake-classifier.js';
import { createDefaultSiteConfig } from '../src/config/site-config.js';
import {
  createBaseRequestHandler,
  createMarkdownRequestHandler,
  createScreenshotRequestHandler,
} from '../src/crawlee/handlers.js';
import { RunTargetTracker } from '../src/crawlee/run-target-tracker.js';
import { initializeSchema, openDatabase } from '../src/db/database.js';
import {
  ArtifactRunRepository,
  PageRunRepository,
  ProjectRepository,
  RunLogRepository,
  RunRepository,
  SitePageRepository,
  SiteRepository,
} from '../src/db/repositories/index.js';
import { FakeMarkdownCaptureAdapter } from '../src/markdown/fake-markdown-adapter.js';
import { RunPlanner } from '../src/planner/run-planner.js';
import { FakeScreenshotCaptureAdapter } from '../src/screenshot/fake-screenshot-adapter.js';
import { SystemClock } from '../src/utils/clock.js';
import { createTempDir } from './helpers/tmp.js';

const noopRunLog: RunLogRepository = {
  log: () => {},
  listByRun: () => [],
} as unknown as RunLogRepository;

describe('integration spike', () => {
  it('executes base -> artifact queues through the queue boundary and persists exported outputs', async () => {
    const dir = createTempDir('kvault-spike-');
    const dbPath = join(dir, 'spike.db');
    const storageDir = join(dir, 'storage');
    const baseUrl = 'https://example.com/docs?utm_source=test';
    const db = openDatabase(dbPath);
    initializeSchema(db);
    const clock = new SystemClock();
    const projectRepository = new ProjectRepository(db, clock);
    const siteRepository = new SiteRepository(db, clock);
    const runRepository = new RunRepository(db, clock);
    const sitePageRepository = new SitePageRepository(db, clock);
    const pageRunRepository = new PageRunRepository(db, clock);
    const artifactRunRepository = new ArtifactRunRepository(db, clock);
    const planner = new RunPlanner(sitePageRepository, clock);
    const project = projectRepository.create('Spike Project');
    const siteConfig = createDefaultSiteConfig(baseUrl);
    siteConfig.rulesBeforeStage2Eq = [
      {
        name: 'default-markdown',
        matchType: 'label',
        listType: 'whitelist',
        when: [
          {
            key: 'content_type',
            op: 'any_of',
            values: ['docs', 'product', 'generic'],
          },
        ],
        artifacts: ['markdown', 'screenshot'],
      },
    ];
    const site = siteRepository.create({
      projectId: project.id,
      name: 'example-docs',
      baseUrl: 'https://example.com',
      storageRoot: storageDir,
      config: siteConfig,
    });
    const runId = runRepository.createRun({
      siteId: site.id,
      runType: 'crawl_run',
      updatePolicy: 'force_recrawl_all',
      targetSuccessCount: null,
      configSnapshot: site.config,
    });
    const sitePageId = sitePageRepository.upsertDiscovery({
      siteId: site.id,
      discoveredUrl: baseUrl,
      normalizedUrl: 'https://example.com/docs',
      discoverySource: 'seed_url',
      discoveryReferrerUrl: null,
      inventoryStatus: 'discovered_only',
      urlRuleDecision: 'allow',
    });

    const configuration = new Configuration({
      persistStorage: true,
      purgeOnStart: false,
      storageClientOptions: {
        localDataDirectory: storageDir,
      },
    });

    const baseQueue = await RequestQueue.open(`run-${runId}-base`, {
      config: configuration,
    });
    const markdownQueue = await RequestQueue.open(`run-${runId}-markdown`, {
      config: configuration,
    });
    const screenshotQueue = await RequestQueue.open(`run-${runId}-screenshot`, {
      config: configuration,
    });
    const artifactWriter = new FileArtifactWriter(storageDir);

    const baseHandler = createBaseRequestHandler({
      classifier: new FakeClassifier(),
      siteConfig: site.config,
      runType: 'crawl_run',
      updatePolicy: 'force_recrawl_all',
      staleAfterMs: null,
      baseQueue,
      markdownQueue,
      screenshotQueue,
      artifactWriter,
      pageRunRepository,
      sitePageRepository,
      runPlanner: planner,
      runLog: noopRunLog,
    });
    const markdownHandler = createMarkdownRequestHandler({
      markdownAdapter: new FakeMarkdownCaptureAdapter(),
      artifactRunRepository,
      sitePageRepository,
      artifactWriter,
      runLog: noopRunLog,
    });
    const screenshotHandler = createScreenshotRequestHandler({
      screenshotAdapter: new FakeScreenshotCaptureAdapter(),
      artifactRunRepository,
      sitePageRepository,
      artifactWriter,
      runLog: noopRunLog,
    });

    const fakeDom = createFakeCheerio({
      title: 'Example Docs',
      metaDescription: 'Tiny docs page',
      bodyText: 'Docs content for the Phase 0 spike.',
      links: [],
    });

    try {
      await baseHandler({
        request: {
          url: baseUrl,
          loadedUrl: baseUrl,
          userData: {
            stage: 'base',
            runId,
            siteId: site.id,
            sitePageId,
            normalizedUrl: 'https://example.com/docs',
            depth: 0,
            runType: 'crawl_run',
          },
        },
        $: fakeDom,
      } as never);

      const markdownRequest = await markdownQueue.fetchNextRequest();
      const screenshotRequest = await screenshotQueue.fetchNextRequest();

      expect(markdownRequest).not.toBeNull();
      expect(screenshotRequest).not.toBeNull();

      await markdownHandler({
        request: markdownRequest!,
      });
      await screenshotHandler({
        request: screenshotRequest!,
      });

      const pageRun = db
        .prepare(
          `SELECT base_capture_path, title, meta_description, decision_outcome, required_artifacts_json
           FROM page_runs
           WHERE crawl_run_id = ?`,
        )
        .get(runId) as {
          base_capture_path: string | null;
          title: string;
          meta_description: string;
          decision_outcome: string;
          required_artifacts_json: string;
        };

      const artifactRuns = db
        .prepare(
          `SELECT artifact_type, status, content, output_path
           FROM artifact_runs
           WHERE crawl_run_id = ?
           ORDER BY artifact_type`,
        )
        .all(runId) as Array<{
          artifact_type: string;
          status: string;
          content: string | null;
          output_path: string;
        }>;

      expect(pageRun.title).toBe('Example Docs');
      expect(pageRun.meta_description).toBe('Tiny docs page');
      expect(pageRun.decision_outcome).toBe('allow');
      expect(pageRun.required_artifacts_json).toBe('["markdown","screenshot"]');
      expect(pageRun.base_capture_path).toBeTruthy();
      expect(existsSync(pageRun.base_capture_path!)).toBe(true);

      expect(artifactRuns).toHaveLength(2);
      expect(artifactRuns[0]?.artifact_type).toBe('markdown');
      expect(artifactRuns[0]?.status).toBe('succeeded');
      expect(artifactRuns[0]?.content).toContain('https://example.com/docs');
      expect(existsSync(artifactRuns[0]!.output_path)).toBe(true);
      expect(artifactRuns[1]?.artifact_type).toBe('screenshot');
      expect(artifactRuns[1]?.status).toBe('succeeded');
      expect(artifactRuns[1]?.content).toBeNull();
      expect(existsSync(artifactRuns[1]!.output_path)).toBe(true);
      expect(pageRunRepository.countByRun(runId)).toBe(1);
      expect(artifactRunRepository.countByRun(runId)).toBe(2);
    } finally {
      db.close();
    }
  });

  it('supports applying url rules again before stage2 enqueue', async () => {
    const dir = createTempDir('kvault-spike-stage2-url-');
    const dbPath = join(dir, 'spike.db');
    const storageDir = join(dir, 'storage');
    const baseUrl = 'https://example.com/blog/post';
    const db = openDatabase(dbPath);
    initializeSchema(db);
    const clock = new SystemClock();
    const projectRepository = new ProjectRepository(db, clock);
    const siteRepository = new SiteRepository(db, clock);
    const runRepository = new RunRepository(db, clock);
    const sitePageRepository = new SitePageRepository(db, clock);
    const pageRunRepository = new PageRunRepository(db, clock);
    const artifactRunRepository = new ArtifactRunRepository(db, clock);
    const planner = new RunPlanner(sitePageRepository, clock);
    const project = projectRepository.create('Spike Project');
    const siteConfig = createDefaultSiteConfig(baseUrl);

    siteConfig.rulesBeforeBaseEq = [
      {
        name: 'allow-site',
        matchType: 'url',
        listType: 'scopelist',
        ruleType: 'prefix',
        values: ['example.com'],
      },
    ];
    siteConfig.rulesBeforeStage2Eq = [
      {
        name: 'deny-stage2-blog',
        matchType: 'url',
        listType: 'blacklist',
        ruleType: 'prefix',
        values: ['example.com/blog'],
      },
      {
        name: 'allow-generic',
        matchType: 'label',
        listType: 'whitelist',
        when: [
          {
            key: 'content_type',
            op: 'any_of',
            values: ['generic'],
          },
        ],
        artifacts: ['markdown', 'screenshot'],
      },
    ];

    const site = siteRepository.create({
      projectId: project.id,
      name: 'example-blog',
      baseUrl: 'https://example.com',
      storageRoot: storageDir,
      config: siteConfig,
    });
    const runId = runRepository.createRun({
      siteId: site.id,
      runType: 'crawl_run',
      updatePolicy: 'force_recrawl_all',
      targetSuccessCount: null,
      configSnapshot: site.config,
    });
    const sitePageId = sitePageRepository.upsertDiscovery({
      siteId: site.id,
      discoveredUrl: baseUrl,
      normalizedUrl: baseUrl,
      discoverySource: 'seed_url',
      discoveryReferrerUrl: null,
      inventoryStatus: 'discovered_only',
      urlRuleDecision: 'allow',
    });

    const configuration = new Configuration({
      persistStorage: true,
      purgeOnStart: false,
      storageClientOptions: {
        localDataDirectory: storageDir,
      },
    });

    const baseQueue = await RequestQueue.open(`run-${runId}-base`, {
      config: configuration,
    });
    const markdownQueue = await RequestQueue.open(`run-${runId}-markdown`, {
      config: configuration,
    });
    const screenshotQueue = await RequestQueue.open(`run-${runId}-screenshot`, {
      config: configuration,
    });
    const artifactWriter = new FileArtifactWriter(storageDir);

    const baseHandler = createBaseRequestHandler({
      classifier: new FakeClassifier(),
      siteConfig: site.config,
      runType: 'crawl_run',
      updatePolicy: 'force_recrawl_all',
      staleAfterMs: null,
      baseQueue,
      markdownQueue,
      screenshotQueue,
      artifactWriter,
      pageRunRepository,
      sitePageRepository,
      runPlanner: planner,
      runLog: noopRunLog,
    });

    const fakeDom = createFakeCheerio({
      title: 'Example Blog',
      metaDescription: 'Tiny blog page',
      bodyText: 'Generic content for stage2 filtering.',
      links: [],
    });

    try {
      await baseHandler({
        request: {
          url: baseUrl,
          loadedUrl: baseUrl,
          userData: {
            stage: 'base',
            runId,
            siteId: site.id,
            sitePageId,
            normalizedUrl: baseUrl,
            depth: 0,
            runType: 'crawl_run',
          },
        },
        $: fakeDom,
      } as never);

      expect(await markdownQueue.fetchNextRequest()).toBeNull();
      expect(await screenshotQueue.fetchNextRequest()).toBeNull();
      expect(pageRunRepository.countByRun(runId)).toBe(1);
      expect(artifactRunRepository.countByRun(runId)).toBe(0);

      const pageRun = db
        .prepare(
          `SELECT rule_outcome, decision_outcome, decision_reason, required_artifacts_json
           FROM page_runs
           WHERE crawl_run_id = ?`,
        )
        .get(runId) as {
          rule_outcome: string;
          decision_outcome: string;
          decision_reason: string | null;
          required_artifacts_json: string;
        };

      expect(pageRun).toEqual({
        rule_outcome: 'deny',
        decision_outcome: 'deny',
        decision_reason: 'matched blacklist rule deny-stage2-blog',
        required_artifacts_json: '[]',
      });
    } finally {
      db.close();
    }
  });

  it('stops expanding base links after the target success count is reached', async () => {
    const dir = createTempDir('kvault-spike-target-');
    const dbPath = join(dir, 'spike.db');
    const storageDir = join(dir, 'storage');
    const baseUrl = 'https://example.com/docs';
    const db = openDatabase(dbPath);
    initializeSchema(db);
    const clock = new SystemClock();
    const projectRepository = new ProjectRepository(db, clock);
    const siteRepository = new SiteRepository(db, clock);
    const runRepository = new RunRepository(db, clock);
    const sitePageRepository = new SitePageRepository(db, clock);
    const pageRunRepository = new PageRunRepository(db, clock);
    const planner = new RunPlanner(sitePageRepository, clock);
    const project = projectRepository.create('Target Project');
    const siteConfig = createDefaultSiteConfig(baseUrl);
    siteConfig.rulesBeforeStage2Eq = [
      {
        name: 'default-markdown',
        matchType: 'label',
        listType: 'whitelist',
        when: [
          {
            key: 'content_type',
            op: 'any_of',
            values: ['docs', 'product', 'generic'],
          },
        ],
        artifacts: ['markdown', 'screenshot'],
      },
    ];
    const site = siteRepository.create({
      projectId: project.id,
      name: 'target-site',
      baseUrl: 'https://example.com',
      storageRoot: storageDir,
      config: siteConfig,
    });
    const runId = runRepository.createRun({
      siteId: site.id,
      runType: 'crawl_run',
      updatePolicy: 'force_recrawl_all',
      targetSuccessCount: 1,
      configSnapshot: site.config,
    });
    const sitePageId = sitePageRepository.upsertDiscovery({
      siteId: site.id,
      discoveredUrl: baseUrl,
      normalizedUrl: baseUrl,
      discoverySource: 'seed_url',
      discoveryReferrerUrl: null,
      inventoryStatus: 'discovered_only',
      urlRuleDecision: 'allow',
    });

    const configuration = new Configuration({
      persistStorage: true,
      purgeOnStart: false,
      storageClientOptions: {
        localDataDirectory: storageDir,
      },
    });

    const baseQueue = await RequestQueue.open(`run-${runId}-base`, {
      config: configuration,
    });
    const markdownQueue = await RequestQueue.open(`run-${runId}-markdown`, {
      config: configuration,
    });
    const screenshotQueue = await RequestQueue.open(`run-${runId}-screenshot`, {
      config: configuration,
    });

    const baseHandler = createBaseRequestHandler({
      classifier: new FakeClassifier(),
      siteConfig: site.config,
      runType: 'crawl_run',
      updatePolicy: 'force_recrawl_all',
      staleAfterMs: null,
      baseQueue,
      markdownQueue,
      screenshotQueue,
      artifactWriter: new FileArtifactWriter(storageDir),
      pageRunRepository,
      sitePageRepository,
      runPlanner: planner,
      runLog: noopRunLog,
      targetTracker: new RunTargetTracker(1),
    });

    const fakeDom = createFakeCheerio({
      title: 'Example Docs',
      metaDescription: 'Tiny docs page',
      bodyText: 'Docs content for target limiting.',
      links: ['https://example.com/docs/a', 'https://example.com/docs/b'],
    });

    try {
      await baseHandler({
        request: {
          url: baseUrl,
          loadedUrl: baseUrl,
          userData: {
            stage: 'base',
            runId,
            siteId: site.id,
            sitePageId,
            normalizedUrl: baseUrl,
            depth: 0,
            runType: 'crawl_run',
          },
        },
        $: fakeDom,
      } as never);

      expect(pageRunRepository.countByRun(runId)).toBe(1);
      expect(await markdownQueue.fetchNextRequest()).not.toBeNull();
      expect(await screenshotQueue.fetchNextRequest()).not.toBeNull();
      expect(await baseQueue.fetchNextRequest()).toBeNull();
    } finally {
      db.close();
    }
  });
});

function createFakeCheerio(input: {
  title: string;
  metaDescription: string;
  bodyText: string;
  links: string[];
}) {
  return (selector: string | { attr(name: string): string | undefined }) => {
    if (typeof selector !== 'string') {
      return {
        first() {
          return this;
        },
        text() {
          return '';
        },
        attr(name: string) {
          return selector.attr(name);
        },
        each() {
          return undefined;
        },
      };
    }

    if (selector === 'a[href]') {
      return {
        first() {
          return this;
        },
        text() {
          return '';
        },
        attr() {
          return undefined;
        },
        each(callback: (index: number, element: { attr(name: string): string | undefined }) => void) {
          input.links.forEach((href, index) => {
            callback(index, {
              attr(name: string) {
                return name === 'href' ? href : undefined;
              },
            });
          });
        },
      };
    }

    const value =
      selector === 'title'
        ? input.title
        : selector === 'meta[name="description"]'
          ? input.metaDescription
          : selector === 'body'
            ? input.bodyText
            : '';

    return {
      first() {
        return this;
      },
      text() {
        return value;
      },
      attr(name: string) {
        if (selector === 'meta[name="description"]' && name === 'content') {
          return value;
        }

        return undefined;
      },
      each() {
        return undefined;
      },
    };
  };
}
