import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BrowserManager } from '../browser-provider.js';
import { PythonBridge } from '../python-bridge.js';
import type { CaptureInput, CaptureTool, CaptureToolResult } from '../types.js';

function resolvePythonToolScript(fileName: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'pytools', fileName),
    join(process.cwd(), 'dist', 'src', 'capture', 'pytools', fileName),
    join(process.cwd(), 'src', 'capture', 'pytools', fileName),
    join(here, '..', '..', '..', 'src', 'capture', 'pytools', fileName),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`Python capture tool script not found: ${fileName}`);
  }
  return found;
}

export class Crawl4AITool implements CaptureTool {
  readonly name = 'crawl4ai-page';
  readonly capabilities = ['base', 'markdown', 'screenshot', 'structured'] as const;

  constructor(bridgeOrBrowserManager?: PythonBridge | BrowserManager) {
    this.bridge = bridgeOrBrowserManager instanceof PythonBridge
      ? bridgeOrBrowserManager
      : new PythonBridge({
          toolName: 'crawl4ai-page',
          scriptPath: resolvePythonToolScript('crawl4ai_tool.py'),
          timeoutMs: 120_000,
          browserManager: bridgeOrBrowserManager,
        });
  }

  private readonly bridge: PythonBridge;

  async capture(input: CaptureInput): Promise<CaptureToolResult> {
    return this.bridge.capture(input);
  }
}

export class ScraplingTool implements CaptureTool {
  readonly name = 'scrapling-page';
  readonly capabilities = ['base', 'structured'] as const;

  constructor(bridgeOrBrowserManager?: PythonBridge | BrowserManager) {
    this.bridge = bridgeOrBrowserManager instanceof PythonBridge
      ? bridgeOrBrowserManager
      : new PythonBridge({
          toolName: 'scrapling-page',
          scriptPath: resolvePythonToolScript('scrapling_tool.py'),
          timeoutMs: 120_000,
          browserManager: bridgeOrBrowserManager,
        });
  }

  private readonly bridge: PythonBridge;

  async capture(input: CaptureInput): Promise<CaptureToolResult> {
    return this.bridge.capture(input);
  }
}
