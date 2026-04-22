import { join } from 'node:path';

import { Configuration, RequestQueue } from 'crawlee';
import { describe, expect, it } from 'vitest';

import { FakeClassifier } from '../src/classification/fake-classifier.js';
import { createBaseRequestHandler, createMarkdownRequestHandler } from '../src/crawlee/handlers.js';
import { initializeSchema, openDatabase } from '../src/db/database.js';
import {
  ArtifactRunRepository,
  PageRunRepository,
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
    const siteRepository = new SiteRepository(db, clock);
    const runRepository = new RunRepository(db, clock);
    const sitePageRepository = new SitePageRepository(db, clock);
    const pageRunRepository = new PageRunRepository(db, clock);
    const artifactRunRepository = new ArtifactRunRepository(db, clock);
    const planner = new RunPlanner(siteRepository, runRepository, sitePageRepository);

    const plannedRun = planner.plan({
      seedUrl: baseUrl,
      siteName: 'example-docs',
    });

    const configuration = new Configuration({
      persistStorage: true,
      purgeOnStart: false,
      storageClientOptions: {
        localDataDirectory: storageDir,
      },
    });

    const markdownQueue = await RequestQueue.open(`run-${plannedRun.runId}-markdown`, {
      config: configuration,
    });

    const baseHandler = createBaseRequestHandler({
      classifier: new FakeClassifier(),
      markdownQueue,
      pageRunRepository,
      sitePageRepository,
    });
    const markdownHandler = createMarkdownRequestHandler({
      markdownAdapter: new FakeMarkdownCaptureAdapter(),
      artifactRunRepository,
    });

    const fakeDom = createFakeCheerio({
      title: 'Example Docs',
      metaDescription: 'Tiny docs page',
      bodyText: 'Docs content for the Phase 0 spike.',
    });

    try {
      await baseHandler({
        request: {
          url: baseUrl,
          loadedUrl: baseUrl,
          userData: {
            stage: 'base',
            runId: plannedRun.runId,
            siteId: plannedRun.siteId,
            sitePageId: plannedRun.sitePageId,
            normalizedUrl: plannedRun.normalizedUrl,
          },
        },
        $: fakeDom,
        enqueueLinks: async () => ({
          processedRequests: [],
          unprocessedRequests: [],
        }),
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
        .get(plannedRun.runId) as {
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
        .get(plannedRun.runId) as {
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
      expect(pageRunRepository.countByRun(plannedRun.runId)).toBe(1);
      expect(artifactRunRepository.countByRun(plannedRun.runId)).toBe(1);
    } finally {
      db.close();
    }
  });
});

function createFakeCheerio(input: {
  title: string;
  metaDescription: string;
  bodyText: string;
}) {
  return (selector: string) => {
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
    };
  };
}
