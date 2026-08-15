import { afterEach, describe, expect, it } from 'vitest';

import {
  PlaywrightBrowserManager,
  type BrowserManager,
} from '../src/capture/browser-provider.js';
import { PlaywrightScreenshotTool } from '../src/capture/captools/playwright-screenshot-tool.js';
import { ScraplingTool } from '../src/capture/captools/scrapling-tool.js';
import type { CaptureInput, RuntimeContext } from '../src/capture/types.js';
import { createDefaultSiteConfig } from '../src/config/site-config.js';
import {
  DEFAULT_SCREENSHOT_PREPARATION,
  expandArtifactRequirements,
} from '../src/domain/artifact-requirements.js';
import { prepareScreenshot } from '../src/capture/screenshot-preparation.js';
import type {
  ArtifactRequirement,
  BrowserConfig,
  SiteConfig,
} from '../src/domain/types.js';
import { startTestSiteServer, type TestSiteServer } from './helpers/site-server.js';

function browserConfig(): BrowserConfig {
  return {
    engine: 'chromium',
    profileMode: 'ephemeral',
    reuse: 'run_browser',
    contextReuse: 'site_session_proxy',
    pageReuse: 'none',
    proxyBinding: 'none',
  };
}

function runtime(): RuntimeContext {
  return {
    requestId: 'advanced-screenshot-e2e',
    async sendRequest(url: string) {
      const response = await fetch(url);
      return {
        statusCode: response.status,
        url: response.url,
        body: await response.text(),
      };
    },
  };
}

function siteConfig(baseUrl: string): SiteConfig {
  const config = createDefaultSiteConfig(baseUrl);
  config.browser = browserConfig();
  config.screenshot = {
    mode: 'complete',
    preparation: {
      ...DEFAULT_SCREENSHOT_PREPARATION,
      settleMs: 50,
      timeoutMs: 15_000,
    },
    variants: [{
      key: 'desktop-800',
      device: 'desktop',
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 1,
    }, {
      key: 'mobile-iphone-15',
      device: 'iPhone 15',
    }],
  };
  return config;
}

function captureInput(
  url: string,
  config: SiteConfig,
  artifactRequirement: ArtifactRequirement,
): CaptureInput {
  return {
    runId: 1,
    siteId: 1,
    url,
    normalizedUrl: url,
    needs: ['screenshot'],
    siteConfig: config,
    artifactRequirement,
    runtime: runtime(),
  };
}

function pngDimensions(png: Buffer): { width: number; height: number } {
  expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}

describe('advanced screenshot real browser capture', () => {
  let server: TestSiteServer | null = null;
  let manager: BrowserManager | null = null;

  afterEach(async () => {
    await manager?.close().catch(() => {});
    await server?.close().catch(() => {});
    manager = null;
    server = null;
  });

  it('prepares and captures desktop and mobile variants with real chromium', async () => {
    server = await startTestSiteServer();
    manager = new PlaywrightBrowserManager({ browser: browserConfig() });
    const config = siteConfig(server.baseUrl);
    const requirements = expandArtifactRequirements(['screenshot'], config);
    const tool = new PlaywrightScreenshotTool(manager);
    const url = `${server.baseUrl}/advanced-screenshot`;
    const results = [];

    for (const requirement of requirements) {
      results.push(await tool.capture(captureInput(url, config, requirement)));
    }

    expect(results.map((result) => result.screenshotMetadata?.variantKey)).toEqual([
      'desktop-800',
      'mobile-iphone-15',
    ]);
    expect(results[0].screenshotMetadata).toMatchObject({
      mode: 'complete',
      variantKey: 'desktop-800',
      configFingerprint: requirements[0].configFingerprint,
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    });

    for (const result of results) {
      expect(result.finalUrl).toBe(url);
      expect(result.screenshot?.byteLength).toBeGreaterThan(0);
      expect(result.screenshotMetadata).toMatchObject({
        documentScrollCompleted: true,
        scrollContainersFound: 1,
        scrollContainersCompleted: 1,
        scrollContainersExpanded: 1,
        truncated: false,
        limitReason: null,
      });
      const metadata = result.screenshotMetadata!;
      const dimensions = pngDimensions(result.screenshot!);
      expect(dimensions.width).toBe(metadata.captureWidth! * metadata.viewport.deviceScaleFactor);
      expect(dimensions.height).toBe(metadata.captureHeight! * metadata.viewport.deviceScaleFactor);
      expect(metadata.captureHeight).toBeGreaterThan(1500);
    }

    expect(results[0].screenshotMetadata?.captureHeight).toBeGreaterThan(2000);
    expect(results.map((result) => result.screenshotMetadata?.captureWidth)).toEqual([800, 980]);
  });

  it('uses the same complete preparation contract through Scrapling', async () => {
    server = await startTestSiteServer();
    manager = new PlaywrightBrowserManager({ browser: browserConfig() });
    const config = siteConfig(server.baseUrl);
    const requirement = expandArtifactRequirements(['screenshot'], config)[0];
    const url = `${server.baseUrl}/advanced-screenshot`;

    const result = await new ScraplingTool(manager).capture(
      captureInput(url, config, requirement),
    );

    expect(result.toolName).toBe('scrapling-page');
    expect(result.finalUrl).toBe(url);
    expect(result.screenshotMetadata).toMatchObject({
      variantKey: 'desktop-800',
      documentScrollCompleted: true,
      scrollContainersFound: 1,
      scrollContainersCompleted: 1,
      scrollContainersExpanded: 1,
      truncated: false,
      limitReason: null,
    });
    const metadata = result.screenshotMetadata!;
    const dimensions = pngDimensions(result.screenshot!);
    expect(dimensions.width).toBe(metadata.captureWidth! * metadata.viewport.deviceScaleFactor);
    expect(dimensions.height).toBe(metadata.captureHeight! * metadata.viewport.deviceScaleFactor);
  });

  it('ignores pending images when waitForImages is disabled', async () => {
    server = await startTestSiteServer();
    manager = new PlaywrightBrowserManager({ browser: browserConfig() });
    const config = siteConfig(server.baseUrl);
    config.screenshot!.preparation!.waitForImages = false;
    config.screenshot!.preparation!.maxScrollRounds = 10;
    config.screenshot!.variants = [config.screenshot!.variants![0]];
    const requirement = expandArtifactRequirements(['screenshot'], config)[0];

    const result = await new PlaywrightScreenshotTool(manager).capture(
      captureInput(`${server.baseUrl}/advanced-screenshot-pending-image`, config, requirement),
    );

    expect(result.screenshotMetadata).toMatchObject({
      imagesPending: 1,
      truncated: false,
      limitReason: null,
    });
  });

  it('dismisses a visible consent overlay before scrolling', async () => {
    server = await startTestSiteServer();
    manager = new PlaywrightBrowserManager({ browser: browserConfig() });
    const config = siteConfig(server.baseUrl);
    const lease = await manager.acquirePage({
      identity: {
        siteId: 1,
        runId: 1,
        engine: 'chromium',
        profileMode: 'ephemeral',
      },
      url: `${server.baseUrl}/advanced-screenshot-consent`,
      runtime: runtime(),
    });

    try {
      await lease.page.goto(`${server.baseUrl}/advanced-screenshot-consent`, { waitUntil: 'load' });
      await prepareScreenshot(lease.page, {
        ...config.screenshot!.preparation!,
        dismissSelectors: ['#consent-decline'],
      });
      expect(await lease.page.evaluate(() => localStorage.getItem('consent'))).toBe('declined');
      expect(await lease.page.locator('#consent-overlay').count()).toBe(0);
    } finally {
      await lease.release();
    }
  });

  it('marks an unscrollable container as truncated', async () => {
    server = await startTestSiteServer();
    manager = new PlaywrightBrowserManager({ browser: browserConfig() });
    const config = siteConfig(server.baseUrl);
    config.screenshot!.variants = [config.screenshot!.variants![0]];
    const requirement = expandArtifactRequirements(['screenshot'], config)[0];

    const result = await new PlaywrightScreenshotTool(manager).capture(
      captureInput(`${server.baseUrl}/advanced-screenshot-stuck-container`, config, requirement),
    );

    expect(result.screenshotMetadata).toMatchObject({
      scrollContainersFound: 1,
      scrollContainersCompleted: 0,
      truncated: true,
      limitReason: 'scrollContainersIncomplete',
    });
  });
});
