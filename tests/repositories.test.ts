import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { initializeSchema, openDatabase } from '../src/db/database.js';
import {
  ArtifactRunRepository,
  PageRunRepository,
  RunRepository,
  SitePageRepository,
  SiteRepository,
} from '../src/db/repositories.js';
import { SystemClock } from '../src/utils/clock.js';
import { createTempDir } from './helpers/tmp.js';

describe('repositories', () => {
  const openHandles: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const handle of openHandles) {
      handle.close();
    }
    openHandles.length = 0;
  });

  it('persists page_runs and artifact_runs for one run', () => {
    const dir = createTempDir('kvault-repos-');
    const db = openDatabase(join(dir, 'state.db'));
    openHandles.push(db);
    initializeSchema(db);

    const clock = new SystemClock();
    const sites = new SiteRepository(db, clock);
    const runs = new RunRepository(db, clock);
    const pages = new SitePageRepository(db, clock);
    const pageRuns = new PageRunRepository(db, clock);
    const artifactRuns = new ArtifactRunRepository(db, clock);

    const siteId = sites.ensureSite('example', 'https://example.com');
    const runId = runs.createRun(siteId, 'https://example.com/docs');
    const sitePageId = pages.createOrGet(
      siteId,
      'https://example.com/docs',
      'https://example.com/docs',
    );

    const pageRunId = pageRuns.create({
      runId,
      sitePageId,
      status: 'succeeded',
      title: 'Docs',
      metaDescription: 'Example docs',
      bodyText: 'hello docs',
      classifierTags: ['docs'],
      ruleDecision: {
        outcome: 'allow',
        requiredArtifacts: ['markdown'],
        reason: null,
      },
    });

    const artifactRunId = artifactRuns.create({
      runId,
      sitePageId,
      artifactType: 'markdown',
      status: 'succeeded',
      content: '# Docs',
    });

    expect(pageRunId).toBeGreaterThan(0);
    expect(artifactRunId).toBeGreaterThan(0);
    expect(pageRuns.countByRun(runId)).toBe(1);
    expect(artifactRuns.countByRun(runId)).toBe(1);
  });
});
