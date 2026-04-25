import { describe, expect, it } from 'vitest';

import {
  createMarkdownFailedRequestHandler,
  createMarkdownRequestHandler,
  createScreenshotFailedRequestHandler,
  createScreenshotRequestHandler,
} from '../src/crawlee/handlers.js';
import type { ArtifactRunRepository, RunLogRepository, SitePageRepository } from '../src/db/repositories/index.js';
import type { FileArtifactWriter } from '../src/export/file-artifact-writer.js';
import type { MarkdownCaptureAdapter } from '../src/markdown/markdown-adapter.js';
import type { ScreenshotCaptureAdapter } from '../src/screenshot/screenshot-adapter.js';

const noopRunLog: RunLogRepository = {
  log: () => {},
  listByRun: () => [],
} as unknown as RunLogRepository;

function makeMarkdownUserData() {
  return {
    stage: 'markdown' as const,
    runId: 1,
    siteId: 10,
    sitePageId: 100,
    pageRunId: 1000,
    normalizedUrl: 'https://example.com/page',
  };
}

function makeScreenshotUserData() {
  return {
    stage: 'screenshot' as const,
    runId: 2,
    siteId: 20,
    sitePageId: 200,
    pageRunId: 2000,
    normalizedUrl: 'https://example.com/page',
  };
}

describe('createMarkdownRequestHandler', () => {
  it('calls adapter, writes artifact, records succeeded run, and updates site page', async () => {
    const artifactRunCalls: Parameters<ArtifactRunRepository['create']>[0][] = [];
    const sitePageCalls: Parameters<SitePageRepository['recordArtifactResult']>[0][] = [];
    const writerCalls: Parameters<FileArtifactWriter['writeTextArtifact']>[0][] = [];

    const handler = createMarkdownRequestHandler({
      markdownAdapter: {
        crawlerType: 'linkedom',
        async capture(url) {
          return { content: `# Page\n\nSource: ${url}\n`, strategyName: 'defuddle' };
        },
      } satisfies MarkdownCaptureAdapter,
      artifactRunRepository: {
        create(args: Parameters<ArtifactRunRepository['create']>[0]) {
          artifactRunCalls.push(args);
          return 1;
        },
      } as unknown as ArtifactRunRepository,
      sitePageRepository: {
        recordArtifactResult(args: Parameters<SitePageRepository['recordArtifactResult']>[0]) {
          sitePageCalls.push(args);
        },
      } as unknown as SitePageRepository,
      artifactWriter: {
        writeTextArtifact(args: Parameters<FileArtifactWriter['writeTextArtifact']>[0]) {
          writerCalls.push(args);
          return { outputPath: '/tmp/markdown.md', content: args.content };
        },
      } as unknown as FileArtifactWriter,
      runLog: noopRunLog,
    });

    const userData = makeMarkdownUserData();
    await handler({
      request: { url: 'https://example.com/page', userData, loadedUrl: 'https://example.com/page' },
      document: undefined,
    });

    expect(writerCalls).toHaveLength(1);
    expect(writerCalls[0].artifactType).toBe('markdown');
    expect(writerCalls[0].content).toContain('# Page');
    expect(writerCalls[0].runId).toBe(userData.runId);
    expect(writerCalls[0].sitePageId).toBe(userData.sitePageId);

    expect(artifactRunCalls).toHaveLength(1);
    expect(artifactRunCalls[0].status).toBe('succeeded');
    expect(artifactRunCalls[0].artifactType).toBe('markdown');
    expect(artifactRunCalls[0].runId).toBe(userData.runId);
    expect(artifactRunCalls[0].errorMessage).toBeNull();
    expect(artifactRunCalls[0].meta).toEqual({ strategy: 'defuddle' });

    expect(sitePageCalls).toHaveLength(1);
    expect(sitePageCalls[0].status).toBe('succeeded');
    expect(sitePageCalls[0].artifactType).toBe('markdown');
    expect(sitePageCalls[0].sitePageId).toBe(userData.sitePageId);
  });

  it('passes document and finalUrl to the adapter', async () => {
    const capturedArgs: Array<{ url: string; context: unknown }> = [];

    const fakeDoc = {} as Document;
    const handler = createMarkdownRequestHandler({
      markdownAdapter: {
        crawlerType: 'linkedom',
        async capture(url, context) {
          capturedArgs.push({ url, context });
          return { content: '# ok\n', strategyName: 'defuddle' };
        },
      } satisfies MarkdownCaptureAdapter,
      artifactRunRepository: { create: () => 1 } as unknown as ArtifactRunRepository,
      sitePageRepository: {
        recordArtifactResult: () => {},
      } as unknown as SitePageRepository,
      artifactWriter: {
        writeTextArtifact: () => ({ outputPath: '/tmp/x.md', content: '# ok\n' }),
      } as unknown as FileArtifactWriter,
      runLog: noopRunLog,
    });

    await handler({
      request: {
        url: 'https://example.com/page',
        userData: makeMarkdownUserData(),
        loadedUrl: 'https://example.com/redirected',
      },
      document: fakeDoc,
    });

    expect(capturedArgs).toHaveLength(1);
    expect(capturedArgs[0].url).toBe('https://example.com/page');
    expect((capturedArgs[0].context as { document: Document }).document).toBe(fakeDoc);
    expect((capturedArgs[0].context as { finalUrl: string }).finalUrl).toBe(
      'https://example.com/redirected',
    );
  });
});

describe('createMarkdownFailedRequestHandler', () => {
  it('records failed artifact run with error message and updates site page', async () => {
    const artifactRunCalls: Parameters<ArtifactRunRepository['create']>[0][] = [];
    const sitePageCalls: Parameters<SitePageRepository['recordArtifactResult']>[0][] = [];

    const handler = createMarkdownFailedRequestHandler({
      artifactRunRepository: {
        create(args: Parameters<ArtifactRunRepository['create']>[0]) {
          artifactRunCalls.push(args);
          return 1;
        },
      } as unknown as ArtifactRunRepository,
      sitePageRepository: {
        recordArtifactResult(args: Parameters<SitePageRepository['recordArtifactResult']>[0]) {
          sitePageCalls.push(args);
        },
      } as unknown as SitePageRepository,
      runLog: noopRunLog,
    });

    const userData = makeMarkdownUserData();
    await handler({ request: { userData } }, new Error('network timeout'));

    expect(artifactRunCalls).toHaveLength(1);
    expect(artifactRunCalls[0].status).toBe('failed');
    expect(artifactRunCalls[0].errorMessage).toBe('network timeout');
    expect(artifactRunCalls[0].content).toBeNull();
    expect(artifactRunCalls[0].outputPath).toBeNull();
    expect(artifactRunCalls[0].artifactType).toBe('markdown');
    expect(artifactRunCalls[0].runId).toBe(userData.runId);
    expect(artifactRunCalls[0].meta).toBeNull();

    expect(sitePageCalls).toHaveLength(1);
    expect(sitePageCalls[0].status).toBe('failed');
    expect(sitePageCalls[0].artifactType).toBe('markdown');
    expect(sitePageCalls[0].sitePageId).toBe(userData.sitePageId);
  });
});

describe('createScreenshotRequestHandler', () => {
  it('calls adapter, writes binary artifact, records succeeded run, and updates site page', async () => {
    const artifactRunCalls: Parameters<ArtifactRunRepository['create']>[0][] = [];
    const sitePageCalls: Parameters<SitePageRepository['recordArtifactResult']>[0][] = [];
    const writerCalls: Parameters<FileArtifactWriter['writeBinaryArtifact']>[0][] = [];

    const fakeBuffer = Buffer.from([1, 2, 3]);

    const handler = createScreenshotRequestHandler({
      screenshotAdapter: {
        crawlerType: 'playwright',
        async capture() {
          return { data: fakeBuffer, extension: 'png', toolName: 'playwright' };
        },
      } satisfies ScreenshotCaptureAdapter,
      artifactRunRepository: {
        create(args: Parameters<ArtifactRunRepository['create']>[0]) {
          artifactRunCalls.push(args);
          return 1;
        },
      } as unknown as ArtifactRunRepository,
      sitePageRepository: {
        recordArtifactResult(args: Parameters<SitePageRepository['recordArtifactResult']>[0]) {
          sitePageCalls.push(args);
        },
      } as unknown as SitePageRepository,
      artifactWriter: {
        writeBinaryArtifact(args: Parameters<FileArtifactWriter['writeBinaryArtifact']>[0]) {
          writerCalls.push(args);
          return { outputPath: '/tmp/screenshot.png', content: null };
        },
      } as unknown as FileArtifactWriter,
      runLog: noopRunLog,
    });

    const userData = makeScreenshotUserData();
    await handler({
      request: { url: 'https://example.com/page', userData, loadedUrl: 'https://example.com/page' },
      page: undefined,
    });

    expect(writerCalls).toHaveLength(1);
    expect(writerCalls[0].artifactType).toBe('screenshot');
    expect(writerCalls[0].content).toBe(fakeBuffer);
    expect(writerCalls[0].extension).toBe('png');
    expect(writerCalls[0].runId).toBe(userData.runId);
    expect(writerCalls[0].sitePageId).toBe(userData.sitePageId);

    expect(artifactRunCalls).toHaveLength(1);
    expect(artifactRunCalls[0].status).toBe('succeeded');
    expect(artifactRunCalls[0].artifactType).toBe('screenshot');
    expect(artifactRunCalls[0].runId).toBe(userData.runId);
    expect(artifactRunCalls[0].errorMessage).toBeNull();
    expect(artifactRunCalls[0].meta).toEqual({ tool: 'playwright' });

    expect(sitePageCalls).toHaveLength(1);
    expect(sitePageCalls[0].status).toBe('succeeded');
    expect(sitePageCalls[0].artifactType).toBe('screenshot');
    expect(sitePageCalls[0].sitePageId).toBe(userData.sitePageId);
  });

  it('passes page and finalUrl to the adapter', async () => {
    const capturedArgs: Array<{ url: string; context: unknown }> = [];
    const fakePage = { screenshot: async () => Buffer.from([]) };

    const handler = createScreenshotRequestHandler({
      screenshotAdapter: {
        crawlerType: 'playwright',
        async capture(url, context) {
          capturedArgs.push({ url, context });
          return { data: Buffer.from([1]), extension: 'png', toolName: 'playwright' };
        },
      } satisfies ScreenshotCaptureAdapter,
      artifactRunRepository: { create: () => 1 } as unknown as ArtifactRunRepository,
      sitePageRepository: {
        recordArtifactResult: () => {},
      } as unknown as SitePageRepository,
      artifactWriter: {
        writeBinaryArtifact: () => ({ outputPath: '/tmp/x.png', content: null }),
      } as unknown as FileArtifactWriter,
      runLog: noopRunLog,
    });

    await handler({
      request: {
        url: 'https://example.com/page',
        userData: makeScreenshotUserData(),
        loadedUrl: 'https://example.com/redirected',
      },
      page: fakePage as never,
    });

    expect(capturedArgs).toHaveLength(1);
    expect(capturedArgs[0].url).toBe('https://example.com/page');
    expect((capturedArgs[0].context as { page: unknown }).page).toBe(fakePage);
    expect((capturedArgs[0].context as { finalUrl: string }).finalUrl).toBe(
      'https://example.com/redirected',
    );
  });
});

describe('createScreenshotFailedRequestHandler', () => {
  it('records failed screenshot artifact run with error message and updates site page', async () => {
    const artifactRunCalls: Parameters<ArtifactRunRepository['create']>[0][] = [];
    const sitePageCalls: Parameters<SitePageRepository['recordArtifactResult']>[0][] = [];

    const handler = createScreenshotFailedRequestHandler({
      artifactRunRepository: {
        create(args: Parameters<ArtifactRunRepository['create']>[0]) {
          artifactRunCalls.push(args);
          return 1;
        },
      } as unknown as ArtifactRunRepository,
      sitePageRepository: {
        recordArtifactResult(args: Parameters<SitePageRepository['recordArtifactResult']>[0]) {
          sitePageCalls.push(args);
        },
      } as unknown as SitePageRepository,
      runLog: noopRunLog,
    });

    const userData = makeScreenshotUserData();
    await handler({ request: { userData } }, new Error('page crashed'));

    expect(artifactRunCalls).toHaveLength(1);
    expect(artifactRunCalls[0].status).toBe('failed');
    expect(artifactRunCalls[0].errorMessage).toBe('page crashed');
    expect(artifactRunCalls[0].content).toBeNull();
    expect(artifactRunCalls[0].outputPath).toBeNull();
    expect(artifactRunCalls[0].artifactType).toBe('screenshot');
    expect(artifactRunCalls[0].runId).toBe(userData.runId);
    expect(artifactRunCalls[0].meta).toBeNull();

    expect(sitePageCalls).toHaveLength(1);
    expect(sitePageCalls[0].status).toBe('failed');
    expect(sitePageCalls[0].artifactType).toBe('screenshot');
    expect(sitePageCalls[0].sitePageId).toBe(userData.sitePageId);
  });
});
