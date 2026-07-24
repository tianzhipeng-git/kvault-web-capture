import { devices, type BrowserContextOptions, type Page } from 'playwright';

import type {
  ScreenshotMetadata,
  ScreenshotVariantConfig,
} from '../../domain/types.js';
import {
  browserIdentityFromRuntime,
  PlaywrightBrowserManager,
  type BrowserManager,
} from '../browser-provider.js';
import {
  cleanupScreenshotPreparation,
  prepareScreenshot,
} from '../screenshot-preparation.js';
import type { CaptureInput, CaptureTool, CaptureToolResult } from '../types.js';

export async function captureFullPagePng(page: Pick<Page, 'screenshot'>): Promise<Buffer> {
  return page.screenshot({ fullPage: true, type: 'png' });
}

function resolveVariant(input: CaptureInput): ScreenshotVariantConfig {
  const key = input.artifactRequirement?.variantKey;
  const variant = input.siteConfig.screenshot?.variants?.find((item) => item.key === key);
  if (!variant) {
    throw new Error(`Screenshot variant ${key ?? '(missing)'} is not configured`);
  }
  return variant;
}

function emulation(variant: ScreenshotVariantConfig): BrowserContextOptions {
  if ('viewport' in variant) {
    return {
      viewport: variant.viewport,
      screen: variant.viewport,
      deviceScaleFactor: variant.deviceScaleFactor,
      isMobile: false,
      hasTouch: false,
    };
  }
  return { ...devices[variant.device] };
}

export class PlaywrightScreenshotTool implements CaptureTool {
  readonly name = 'playwright-screenshot';
  readonly capabilities = ['screenshot'] as const;
  private readonly browserManager: BrowserManager;

  constructor(browserManager?: BrowserManager) {
    this.browserManager = browserManager ?? new PlaywrightBrowserManager();
  }

  supports(capability: 'screenshot', input: CaptureInput) {
    if (capability !== 'screenshot' || input.siteConfig.screenshot?.mode !== 'complete') {
      return { supported: true };
    }
    return {
      supported: input.artifactRequirement?.artifactType === 'screenshot' &&
        input.artifactRequirement.configFingerprint !== null,
      reason: 'complete screenshot requires an artifact requirement',
    };
  }

  async capture(input: CaptureInput): Promise<CaptureToolResult> {
    const complete = input.siteConfig.screenshot?.mode === 'complete';
    const variant = complete ? resolveVariant(input) : null;
    const variantEmulation = variant ? emulation(variant) : undefined;
    const identity = browserIdentityFromRuntime({
      runId: input.runId,
      siteId: input.siteId,
      siteConfig: input.siteConfig,
      runtime: input.runtime,
    });
    if (complete) {
      identity.emulationFingerprint = input.artifactRequirement!.configFingerprint!;
    }
    const lease = await this.browserManager.acquirePage({
      identity,
      url: input.url,
      runtime: input.runtime,
      emulation: variantEmulation,
    });

    try {
      await lease.page.goto(input.url, { waitUntil: 'load', timeout: 45_000 });
      if (!complete) {
        await lease.page.waitForTimeout(3000);
        return {
          toolName: this.name,
          finalUrl: lease.page.url(),
          screenshot: await captureFullPagePng(lease.page),
          screenshotExtension: 'png',
        };
      }

      const preparation = input.siteConfig.screenshot!.preparation!;
      const prepared = await prepareScreenshot(lease.page, preparation);
      if (prepared.truncated && preparation.onLimit === 'fail') {
        throw new Error(`Screenshot preparation reached ${prepared.limitReason}`);
      }
      const viewport = lease.page.viewportSize();
      if (!viewport) {
        throw new Error('Screenshot viewport is unavailable');
      }
      const captureHeight = Math.min(prepared.documentHeight, preparation.maxCaptureHeight);
      const limited = prepared.documentHeight > preparation.maxCaptureHeight;
      const captureWidth = limited ? viewport.width : prepared.documentWidth;
      const screenshot = limited
        ? await lease.page.screenshot({
            type: 'png',
            clip: { x: 0, y: 0, width: viewport.width, height: captureHeight },
          })
        : await captureFullPagePng(lease.page);
      const metadata: ScreenshotMetadata = {
        protocolVersion: 1,
        mode: 'complete',
        variantKey: input.artifactRequirement!.variantKey,
        configFingerprint: input.artifactRequirement!.configFingerprint!,
        device: variant!.device,
        viewport: {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: 'viewport' in variant!
            ? (variant as unknown as { deviceScaleFactor: number }).deviceScaleFactor
            : devices[variant!.device].deviceScaleFactor,
        },
        documentScrollCompleted: prepared.documentScrollCompleted,
        scrollContainersFound: prepared.scrollContainersFound,
        scrollContainersCompleted: prepared.scrollContainersCompleted,
        scrollContainersExpanded: prepared.scrollContainersExpanded,
        imagesFound: prepared.imagesFound,
        imagesPending: prepared.imagesPending,
        fontsReady: prepared.fontsReady,
        truncated: prepared.truncated || limited,
        limitReason: limited ? 'maxCaptureHeight' : prepared.limitReason,
        preparationDurationMs: prepared.preparationDurationMs,
        captureWidth,
        captureHeight,
        warnings: prepared.warnings,
      };
      return {
        toolName: this.name,
        finalUrl: lease.page.url(),
        screenshot,
        screenshotExtension: 'png',
        screenshotMetadata: metadata,
      };
    } finally {
      if (complete) {
        await cleanupScreenshotPreparation(lease.page).catch(() => {});
      }
      await lease.release();
    }
  }
}
