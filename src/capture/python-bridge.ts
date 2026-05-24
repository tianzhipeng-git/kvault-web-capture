import { spawn } from 'node:child_process';

import type { CaptureInput, CaptureToolResult } from './types.js';

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
  structured?: unknown;
  diagnostics?: Record<string, unknown>;
}

export interface PythonBridgeOptions {
  toolName: string;
  scriptPath: string;
  pythonPath?: string;
  timeoutMs?: number;
  runProcessFn?: (input: {
    command: string;
    args: string[];
    stdin: string;
    timeoutMs: number;
  }) => Promise<{ stdout: string; stderr: string }>;
}

export class PythonBridge {
  private readonly runProcessFn: NonNullable<PythonBridgeOptions['runProcessFn']>;

  constructor(private readonly options: PythonBridgeOptions) {
    this.runProcessFn = options.runProcessFn ?? runProcess;
  }

  async capture(input: CaptureInput): Promise<CaptureToolResult> {
    const payload = JSON.stringify({
      url: input.url,
      normalizedUrl: input.normalizedUrl,
      needs: input.needs,
      proxyUrl: input.runtime.proxyInfo?.url ?? null,
    });

    let stdout: string;
    let stderr: string;
    try {
      const result = await this.runProcessFn({
        command: this.options.pythonPath ?? process.env.KVAULT_PYTHON ?? 'python3',
        args: [this.options.scriptPath],
        stdin: payload,
        timeoutMs: this.options.timeoutMs ?? 90_000,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      const maybe = error as { code?: unknown; signal?: unknown; stderr?: unknown; killed?: unknown };
      const reason = maybe.killed
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
      throw new Error(`${this.options.toolName} bridge failed with ${reason}${stderrText}`);
    }

    let parsed: PythonBridgeOutput;
    try {
      parsed = JSON.parse(stdout) as PythonBridgeOutput;
    } catch (error) {
      const stderrText = stderr.trim() ? ` stderr=${stderr.trim()}` : '';
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
      markdownStrategyName: parsed.markdown ? this.options.toolName : undefined,
      screenshot: parsed.screenshotBase64
        ? Buffer.from(parsed.screenshotBase64, 'base64')
        : undefined,
      screenshotExtension: parsed.screenshotBase64 ? 'png' : undefined,
      structured: parsed.structured,
      diagnostics: {
        ...parsed.diagnostics,
        stderr: stderr.trim() || undefined,
      },
    };

    return result;
  }
}

async function runProcess(input: {
  command: string;
  args: string[];
  stdin: string;
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, input.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const stdoutText = Buffer.concat(stdout).toString('utf8');
      const stderrText = Buffer.concat(stderr).toString('utf8');
      if (code === 0) {
        resolve({ stdout: stdoutText, stderr: stderrText });
        return;
      }
      const error = new Error(timedOut ? 'timed out' : `exit code ${code ?? 'null'}`);
      Object.assign(error, {
        code,
        signal,
        stderr: stderrText,
        killed: timedOut,
      });
      reject(error);
    });

    child.stdin.end(input.stdin);
  });
}
