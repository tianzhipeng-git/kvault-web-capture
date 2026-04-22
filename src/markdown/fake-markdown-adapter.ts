export interface MarkdownCaptureAdapter {
  capture(url: string): Promise<string>;
}

export class FakeMarkdownCaptureAdapter implements MarkdownCaptureAdapter {
  async capture(url: string): Promise<string> {
    return `# Fake markdown capture\n\nSource: ${url}\n`;
  }
}
