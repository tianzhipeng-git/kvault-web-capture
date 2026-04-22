import { join } from 'node:path';

import { Configuration, RequestQueue } from 'crawlee';
import { describe, expect, it } from 'vitest';

import { FakeClassifier } from '../src/classification/fake-classifier.js';
import { createDefaultSiteConfig } from '../src/config/site-config.js';
import { createBaseRequestHandler, createMarkdownRequestHandler } from '../src/crawlee/handlers.js';
import { initializeSchema, openDatabase } from '../src/db/database.js';
import {
  ArtifactRunRepository,
  PageRunRepository,
  ProjectRepository,
  RunRepository,
  SitePageRepository,
  SiteRepository,
} from '../src/db/repositories.js';
import { FakeMarkdownCaptureAdapter } from '../src/markdown/fake-markdown-adapter.js';
import { RunPlanner } from '../src/planner/run-planner.js';
import { SystemClock } from '../src/utils/clock.js';
import { createTempDir } from './helpers/tmp.js';

describe('integration spike', () => {
  it('executes base -> markdown through the queue boundary and persists both layers', async () => {
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
    const site = siteRepository.create({
      projectId: project.id,
      name: 'example-docs',
      baseUrl: 'https://example.com',
      storageRoot: storageDir,
      config: createDefaultSiteConfig(baseUrl),
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

    const baseHandler = createBaseRequestHandler({
      classifier: new FakeClassifier(),
      siteConfig: site.config,
      runType: 'crawl_run',
      updatePolicy: 'force_recrawl_all',
      staleAfterMs: null,
      baseQueue,
      markdownQueue,
      pageRunRepository,
      sitePageRepository,
      runPlanner: planner,
    });
    const markdownHandler = createMarkdownRequestHandler({
      markdownAdapter: new FakeMarkdownCaptureAdapter(),
      artifactRunRepository,
      sitePageRepository,
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

      expect(markdownRequest).not.toBeNull();

      await markdownHandler({
        request: markdownRequest!,
      });

      const pageRun = db
        .prepare(
          `SELECT title, meta_description, decision_outcome, required_artifacts_json
           FROM page_runs
           WHERE crawl_run_id = ?`,
        )
        .get(runId) as {
          title: string;
          meta_description: string;
          decision_outcome: string;
          required_artifacts_json: string;
        };

      const artifactRun = db
        .prepare(
          `SELECT artifact_type, status, content
           FROM artifact_runs
           WHERE crawl_run_id = ?`,
        )
        .get(runId) as {
          artifact_type: string;
          status: string;
          content: string;
        };

      expect(pageRun.title).toBe('Example Docs');
      expect(pageRun.meta_description).toBe('Tiny docs page');
      expect(pageRun.decision_outcome).toBe('allow');
      expect(pageRun.required_artifacts_json).toBe('["markdown"]');

      expect(artifactRun.artifact_type).toBe('markdown');
      expect(artifactRun.status).toBe('succeeded');
      expect(artifactRun.content).toContain('https://example.com/docs');
      expect(pageRunRepository.countByRun(runId)).toBe(1);
      expect(artifactRunRepository.countByRun(runId)).toBe(1);
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
