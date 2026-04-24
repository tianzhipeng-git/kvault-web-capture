import type { MarkdownCaptureAdapter, MarkdownCaptureResult } from './markdown-adapter.js';

export class FakeMarkdownCaptureAdapter implements MarkdownCaptureAdapter {
  readonly crawlerType = 'basic' as const;

  async capture(url: string): Promise<MarkdownCaptureResult> {
    return {
      content: `# Fake markdown capture\n\nSource: ${url}\n`,
      strategyName: 'fake',
    };
  }
}
