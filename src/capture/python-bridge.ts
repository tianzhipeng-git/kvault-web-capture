import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { devices } from 'playwright';

import {
  browserIdentityFromRuntime,
  type BrowserManager,
  type CdpLease,
} from './browser-provider.js';
import { PYTHON_BRIDGE_TIMEOUT_MS } from './python-bridge-config.js';
import type { CaptureInput, CaptureToolResult } from './types.js';
import type { ScreenshotMetadata, ScreenshotVariantConfig } from '../domain/types.js';
import { logger } from '../utils/runtime-logger.js';

export interface PythonBridgeOutput {
  toolName?: string;
  finalUrl?: string;
  statusCode?: number;
  html?: string;
  title?: string;
  metaDescription?: string;
  bodyText?: string;
  links?: string[];
  markdown?: string;
  screenshotBase64?: string;
  screenshotMetadata?: ScreenshotMetadata;
  structured?: unknown;
  diagnostics?: Record<string, unknown>;
}

export interface PythonBridgeOptions {
  toolName: string;
  scriptPath: string;
  pythonPath?: string;
  timeoutMs?: number;
  browserManager?: BrowserManager;
  runProcessFn?: (input: {
    command: string;
    args: string[];
    stdin: string;
    timeoutMs: number;
    abortSignal?: AbortSignal;
  }) => Promise<{ stdout: string; stderr: string }>;
}

const TOOL_PYTHON_ENV_VARS: Partial<Record<string, string>> = {
  'crawl4ai-page': 'KVAULT_PYTHON_CRAWL4AI',
  'scrapling-page': 'KVAULT_PYTHON_SCRAPLING',
};

const LEGACY_TOOL_PYTHON_VENV_DIRS: Partial<Record<string, string>> = {
  'crawl4ai-page': '.venv-crawl4ai',
  'scrapling-page': '.venv-scrapling',
};

export function resolvePythonCommand(input: {
  cwd?: string;
  toolName?: string;
} = {}): string {
  const cwd = input.cwd ?? process.cwd();
  const toolEnvVar = input.toolName ? TOOL_PYTHON_ENV_VARS[input.toolName] : undefined;
  if (toolEnvVar && process.env[toolEnvVar]) {
    return process.env[toolEnvVar]!;
  }

  if (process.env.KVAULT_PYTHON) {
    return process.env.KVAULT_PYTHON;
  }

  const projectVenvPython = join(cwd, '.venv', 'bin', 'python');
  if (existsSync(projectVenvPython)) {
    return projectVenvPython;
  }

  const toolVenvDir = input.toolName ? LEGACY_TOOL_PYTHON_VENV_DIRS[input.toolName] : undefined;
  if (toolVenvDir) {
    const toolVenvPython = join(cwd, toolVenvDir, 'bin', 'python');
    if (existsSync(toolVenvPython)) {
      return toolVenvPython;
    }
  }

  return 'python3';
}

export class PythonBridge {
  private readonly runProcessFn: NonNullable<PythonBridgeOptions['runProcessFn']>;

  constructor(private readonly options: PythonBridgeOptions) {
    this.runProcessFn = options.runProcessFn ?? runProcess;
  }

  async capture(input: CaptureInput): Promise<CaptureToolResult> {
    const startedAt = Date.now();
    const cdpLease = await this.tryAcquireCdpLease(input);
    const screenshotVariant = input.siteConfig.screenshot?.mode === 'complete'
      ? input.siteConfig.screenshot.variants?.find(
          (variant) => variant.key === input.artifactRequirement?.variantKey,
        )
      : undefined;
    const payload = JSON.stringify({
      url: input.url,
      normalizedUrl: input.normalizedUrl,
      needs: input.needs,
      proxyUrl: input.runtime.proxyInfo?.url ?? null,
      cdpHttpUrl: cdpLease?.cdpHttpUrl ?? null,
      cdpWebSocketUrl: cdpLease?.cdpWebSocketUrl ?? null,
      artifactRequirement: input.artifactRequirement ?? null,
      screenshotConfig: input.siteConfig.screenshot ?? null,
      screenshotVariant: screenshotVariant ?? null,
      screenshotContextOptions: screenshotVariant
        ? screenshotContextOptions(screenshotVariant)
        : null,
    });
    const command = this.options.pythonPath ?? resolvePythonCommand({ toolName: this.options.toolName });
    logger.info('Python bridge capture started', {
      runId: input.runId,
      siteId: input.siteId,
      requestId: input.runtime.requestId,
      url: input.normalizedUrl,
      tool: this.options.toolName,
      scriptPath: this.options.scriptPath,
      needs: input.needs,
      hasProxy: input.runtime.proxyInfo?.url !== undefined,
      hasCdpLease: cdpLease !== null,
      timeoutMs: this.options.timeoutMs ?? PYTHON_BRIDGE_TIMEOUT_MS,
    });

    let stdout: string;
    let stderr: string;
    try {
      const result = await this.runProcessFn({
        command,
        args: [this.options.scriptPath],
        stdin: payload,
        timeoutMs: this.options.timeoutMs ?? PYTHON_BRIDGE_TIMEOUT_MS,
        abortSignal: input.runtime.abortSignal,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      const maybe = error as {
        code?: unknown;
        signal?: unknown;
        stderr?: unknown;
        killed?: unknown;
        aborted?: unknown;
      };
      const reason = maybe.aborted
        ? 'aborted'
        : maybe.killed
          ? 'timed out'
          : maybe.signal
          ? `signal ${String(maybe.signal)}`
          : maybe.code
            ? `exit code ${String(maybe.code)}`
            : error instanceof Error
              ? error.message
              : String(error);
      const stderrText = typeof maybe.stderr === 'string' && maybe.stderr.trim() !== ''
        ? `: ${maybe.stderr.trim()}`
        : '';
      logger.warn('Python bridge capture failed', {
        runId: input.runId,
        siteId: input.siteId,
        requestId: input.runtime.requestId,
        url: input.normalizedUrl,
        tool: this.options.toolName,
        command,
        reason,
        stderr: summarizeText(typeof maybe.stderr === 'string' ? maybe.stderr : ''),
        durationMs: Date.now() - startedAt,
      });
      throw new Error(`${this.options.toolName} bridge failed with ${reason}${stderrText}`);
    } finally {
      await cdpLease?.release().catch(() => {});
    }

    let parsed: PythonBridgeOutput;
    try {
      parsed = JSON.parse(stdout) as PythonBridgeOutput;
    } catch (error) {
      const stderrText = stderr.trim() ? ` stderr=${stderr.trim()}` : '';
      logger.warn('Python bridge returned invalid JSON', {
        runId: input.runId,
        siteId: input.siteId,
        requestId: input.runtime.requestId,
        url: input.normalizedUrl,
        tool: this.options.toolName,
        stdout: summarizeText(stdout),
        stderr: summarizeText(stderr),
        durationMs: Date.now() - startedAt,
      });
      throw new Error(`${this.options.toolName} bridge returned invalid JSON${stderrText}`);
    }

    const finalUrl = parsed.finalUrl ?? input.url;
    const hasExtractedFields =
      parsed.html !== undefined ||
      parsed.title !== undefined ||
      parsed.metaDescription !== undefined ||
      parsed.bodyText !== undefined ||
      (Array.isArray(parsed.links) && parsed.links.length > 0);
    const result: CaptureToolResult = {
      toolName: parsed.toolName ?? this.options.toolName,
      finalUrl,
      statusCode: parsed.statusCode,
      html: parsed.html,
      extracted: hasExtractedFields
        ? {
            url: finalUrl,
            normalizedUrl: input.normalizedUrl,
            title: parsed.title ?? '',
            metaDescription: parsed.metaDescription ?? '',
            bodyText: parsed.bodyText ?? '',
            links: parsed.links ?? [],
          }
        : undefined,
      markdown: parsed.markdown,
      markdownToolName: parsed.markdown ? this.options.toolName : undefined,
      screenshot: parsed.screenshotBase64
        ? Buffer.from(parsed.screenshotBase64, 'base64')
        : undefined,
      screenshotExtension: parsed.screenshotBase64 ? 'png' : undefined,
      screenshotMetadata: parsed.screenshotMetadata,
      structured: parsed.structured,
      diagnostics: {
        ...parsed.diagnostics,
        stderr: stderr.trim() || undefined,
      },
    };

    logger.info('Python bridge capture finished', {
      runId: input.runId,
      siteId: input.siteId,
      requestId: input.runtime.requestId,
      url: input.normalizedUrl,
      tool: this.options.toolName,
      returnedTool: result.toolName,
      finalUrl: result.finalUrl,
      statusCode: result.statusCode,
      capabilities: {
        base: result.extracted !== undefined,
        markdown: result.markdown !== undefined,
        screenshot: result.screenshot !== undefined,
        structured: result.structured !== undefined,
      },
      stderr: summarizeText(stderr),
      durationMs: Date.now() - startedAt,
    });
    return result;
  }

  private async tryAcquireCdpLease(input: CaptureInput): Promise<CdpLease | null> {
    if (!this.options.browserManager) {
      return null;
    }

    try {
      const lease = await this.options.browserManager.acquireCdpEndpoint({
        identity: browserIdentityFromRuntime({
          runId: input.runId,
          siteId: input.siteId,
          siteConfig: input.siteConfig,
          runtime: input.runtime,
        }),
        runtime: input.runtime,
      });
      return lease;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('not implemented')) {
        logger.info('Python bridge continuing without CDP lease', {
          runId: input.runId,
          siteId: input.siteId,
          requestId: input.runtime.requestId,
          url: input.normalizedUrl,
          tool: this.options.toolName,
          reason: message,
        });
        return null;
      }
      throw error;
    }
  }
}

function screenshotContextOptions(variant: ScreenshotVariantConfig): Record<string, unknown> {
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

function summarizeText(value: string, maxLength = 2000): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}...` : trimmed;
}

async function runProcess(input: {
  command: string;
  args: string[];
  stdin: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const finish = (
      handler: typeof resolve | typeof reject,
      value: { stdout: string; stderr: string } | Error,
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      input.abortSignal?.removeEventListener('abort', onAbort);
      if (value instanceof Error) {
        reject(value);
        return;
      }
      handler(value);
    };

    const killChild = (reason: 'timed out' | 'aborted') => {
      if (reason === 'timed out') {
        timedOut = true;
      } else {
        aborted = true;
      }
      child.kill('SIGTERM');
    };

    const timer = setTimeout(() => killChild('timed out'), input.timeoutMs);

    const onAbort = () => {
      killChild('aborted');
    };
    if (input.abortSignal?.aborted) {
      killChild('aborted');
    } else {
      input.abortSignal?.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      finish(reject, error);
    });
    child.on('close', (code, signal) => {
      const stdoutText = Buffer.concat(stdout).toString('utf8');
      const stderrText = Buffer.concat(stderr).toString('utf8');
      if (code === 0) {
        finish(resolve, { stdout: stdoutText, stderr: stderrText });
        return;
      }
      const message = aborted ? 'aborted' : timedOut ? 'timed out' : `exit code ${code ?? 'null'}`;
      const error = new Error(message);
      Object.assign(error, {
        code,
        signal,
        stderr: stderrText,
        killed: timedOut,
        aborted,
      });
      finish(reject, error);
    });

    child.stdin.end(input.stdin);
  });
}
