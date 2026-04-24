import type {
  ScreenshotCaptureAdapter,
  ScreenshotCaptureContext,
  ScreenshotCaptureResult,
} from './screenshot-adapter.js';

export class PlaywrightScreenshotCaptureAdapter implements ScreenshotCaptureAdapter {
  readonly crawlerType = 'playwright' as const;

  async capture(url: string, context?: ScreenshotCaptureContext): Promise<ScreenshotCaptureResult> {
    if (!context?.page) {
      throw new Error(`Playwright screenshot capture requires a page for ${url}`);
    }

    return {
      data: await context.page.screenshot({
        fullPage: true,
        type: 'png',
      }),
      extension: 'png',
      toolName: 'playwright',
    };
  }
}
