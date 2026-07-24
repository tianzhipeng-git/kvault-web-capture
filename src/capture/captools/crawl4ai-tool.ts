import type { BrowserManager } from '../browser-provider.js';
import { PYTHON_BRIDGE_TIMEOUT_MS } from '../python-bridge-config.js';
import { PythonBridge } from '../python-bridge.js';
import type { CaptureInput, CaptureTool, CaptureToolResult } from '../types.js';
import { resolvePythonToolScript } from './resolve-python-tool-script.js';

export class Crawl4AITool implements CaptureTool {
  readonly name = 'crawl4ai-page';
  readonly capabilities = ['base', 'markdown', 'screenshot', 'structured'] as const;

  constructor(bridgeOrBrowserManager?: PythonBridge | BrowserManager) {
    this.bridge = bridgeOrBrowserManager instanceof PythonBridge
      ? bridgeOrBrowserManager
      : new PythonBridge({
          toolName: 'crawl4ai-page',
          scriptPath: resolvePythonToolScript('crawl4ai_tool.py'),
          timeoutMs: PYTHON_BRIDGE_TIMEOUT_MS,
          browserManager: bridgeOrBrowserManager,
        });
  }

  private readonly bridge: PythonBridge;

  supports(capability: 'base' | 'markdown' | 'screenshot' | 'structured', input: CaptureInput) {
    return capability === 'screenshot' && input.siteConfig.screenshot?.mode === 'complete'
      ? { supported: false, reason: 'crawl4ai-page does not implement complete screenshots' }
      : { supported: true };
  }

  async capture(input: CaptureInput): Promise<CaptureToolResult> {
    return this.bridge.capture(input);
  }
}
