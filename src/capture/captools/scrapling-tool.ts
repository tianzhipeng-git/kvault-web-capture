import type { BrowserManager } from '../browser-provider.js';
import { PythonBridge } from '../python-bridge.js';
import type { CaptureInput, CaptureTool, CaptureToolResult } from '../types.js';
import { resolvePythonToolScript } from './resolve-python-tool-script.js';

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
