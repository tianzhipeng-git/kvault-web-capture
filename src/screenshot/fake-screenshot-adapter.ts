import type {
  ScreenshotCaptureAdapter,
  ScreenshotCaptureResult,
} from './screenshot-adapter.js';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/axhN2QAAAAASUVORK5CYII=',
  'base64',
);

export class FakeScreenshotCaptureAdapter implements ScreenshotCaptureAdapter {
  readonly crawlerType = 'basic' as const;

  async capture(_url: string): Promise<ScreenshotCaptureResult> {
    return {
      data: ONE_PIXEL_PNG,
      extension: 'png',
      toolName: 'fake',
    };
  }
}
