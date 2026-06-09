import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

interface ScraplingOutput {
  finalUrl?: string;
  statusCode?: number;
  markdown?: string | null;
  diagnostics?: Record<string, unknown>;
}

interface CliOptions {
  url: string;
  outputPath?: string;
  useCloakBrowser: boolean;
  headed: boolean;
  proxy?: string;
  pythonPath?: string;
  scriptPath?: string;
  timeoutMs: number;
}

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help')) {
  printUsage();
  process.exit(args.length === 0 ? 1 : 0);
}

const options = parseArgs(args);
const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const scriptPath = options.scriptPath
  ? resolve(options.scriptPath)
  : resolveScraplingScript(repoRoot);
const pythonPath = options.pythonPath ?? resolvePythonCommand(repoRoot);
let browser: { close: () => Promise<void> } | undefined;

try {
  let cdpHttpUrl: string | undefined;
  let cdpWebSocketUrl: string | undefined;

  if (options.useCloakBrowser) {
    const lease = await launchCloakBrowser({
      headed: options.headed,
      proxy: options.proxy,
    });
    browser = lease.browser;
    cdpHttpUrl = lease.cdpHttpUrl;
    cdpWebSocketUrl = lease.cdpWebSocketUrl;
  }

  const result = await runScraplingTool({
    pythonPath,
    scriptPath,
    timeoutMs: options.timeoutMs,
    payload: {
      url: options.url,
      normalizedUrl: options.url,
      needs: ['markdown'],
      proxyUrl: options.useCloakBrowser ? null : options.proxy ?? null,
      cdpHttpUrl: cdpHttpUrl ?? null,
      cdpWebSocketUrl: cdpWebSocketUrl ?? null,
    },
  });
  const markdown = (result.markdown ?? '').trim();

  if (!markdown) {
    throw new Error('scrapling-page returned empty markdown');
  }

  if (options.outputPath) {
    const outputPath = resolve(options.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${markdown}\n`, 'utf8');
    console.log(JSON.stringify({
      outputPath,
      finalUrl: result.finalUrl ?? options.url,
      statusCode: result.statusCode ?? null,
      markdownLength: markdown.length,
      diagnostics: result.diagnostics ?? {},
    }, null, 2));
  } else {
    console.log(markdown);
  }
} finally {
  await browser?.close().catch(() => {});
}

function parseArgs(rawArgs: string[]): CliOptions {
  const positional: string[] = [];
  let useCloakBrowser = false;
  let headed = false;
  let proxy: string | undefined;
  let pythonPath: string | undefined;
  let scriptPath: string | undefined;
  let timeoutMs = 180_000;

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    switch (arg) {
      case '--cloakbrowser':
        useCloakBrowser = true;
        break;
      case '--headed':
        headed = true;
        break;
      case '--proxy':
        proxy = readOptionValue(rawArgs, index, arg);
        index += 1;
        break;
      case '--python':
        pythonPath = readOptionValue(rawArgs, index, arg);
        index += 1;
        break;
      case '--script':
        scriptPath = readOptionValue(rawArgs, index, arg);
        index += 1;
        break;
      case '--timeout-ms': {
        const rawValue = readOptionValue(rawArgs, index, arg);
        const parsed = Number.parseInt(rawValue, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error('--timeout-ms must be a positive integer');
        }
        timeoutMs = parsed;
        index += 1;
        break;
      }
      default:
        if (arg.startsWith('--')) {
          throw new Error(`Unknown option: ${arg}`);
        }
        positional.push(arg);
        break;
    }
  }

  const [url, outputPath] = positional;
  if (!url) {
    throw new Error('Missing url');
  }

  return {
    url,
    outputPath,
    useCloakBrowser,
    headed,
    proxy,
    pythonPath,
    scriptPath,
    timeoutMs,
  };
}

function readOptionValue(rawArgs: string[], index: number, name: string): string {
  const value = rawArgs[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function printUsage(): void {
  console.error([
    'Usage: pnpm exec tsx examples/scrapling-markdown-smoke.ts <url> [output-file]',
    '',
    'Options:',
    '  --cloakbrowser       Launch CloakBrowser and pass its CDP websocket URL to Scrapling',
    '  --headed             Show the CloakBrowser window when --cloakbrowser is used',
    '  --proxy <url>        Proxy URL; passed to Scrapling directly or CloakBrowser with --cloakbrowser',
    '  --python <path>      Python executable. Defaults to KVAULT_PYTHON_SCRAPLING, KVAULT_PYTHON, .venv, then python3',
    '  --script <path>      scrapling_tool.py path. Defaults to src/... then dist/src/...',
    '  --timeout-ms <ms>    Python bridge timeout. Default: 180000',
  ].join('\n'));
}

function resolveScraplingScript(cwd: string): string {
  const candidates = [
    join(cwd, 'src/capture/pytools/scrapling_tool.py'),
    join(cwd, 'dist/src/capture/pytools/scrapling_tool.py'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));

  if (found) {
    return found;
  }

  throw new Error([
    'Could not find scrapling_tool.py.',
    'Checked:',
    ...candidates.map((candidate) => `  - ${candidate}`),
    'Pass --script /path/to/dist/src/capture/pytools/scrapling_tool.py to override.',
  ].join('\n'));
}

function resolvePythonCommand(cwd: string): string {
  if (process.env.KVAULT_PYTHON_SCRAPLING) {
    return process.env.KVAULT_PYTHON_SCRAPLING;
  }

  if (process.env.KVAULT_PYTHON) {
    return process.env.KVAULT_PYTHON;
  }

  const projectVenvPython = join(cwd, '.venv', 'bin', 'python');
  if (existsSync(projectVenvPython)) {
    return projectVenvPython;
  }

  const scraplingVenvPython = join(cwd, '.venv-scrapling', 'bin', 'python');
  if (existsSync(scraplingVenvPython)) {
    return scraplingVenvPython;
  }

  return 'python3';
}

async function runScraplingTool(input: {
  pythonPath: string;
  scriptPath: string;
  timeoutMs: number;
  payload: Record<string, unknown>;
}): Promise<ScraplingOutput> {
  console.error(`Running ${input.scriptPath}`);
  console.error(`Python: ${input.pythonPath}`);
  console.error(`Mode: ${input.payload.cdpWebSocketUrl ? 'Scrapling via CloakBrowser CDP' : 'Scrapling self-managed browser'}`);
  console.error(`Timeout: ${input.timeoutMs}ms`);

  const stdout = await runProcess({
    command: input.pythonPath,
    args: [input.scriptPath],
    stdin: JSON.stringify(input.payload),
    timeoutMs: input.timeoutMs,
  });
  return JSON.parse(stdout) as ScraplingOutput;
}

async function runProcess(input: {
  command: string;
  args: string[];
  stdin: string;
  timeoutMs: number;
}): Promise<string> {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(input.command, input.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, input.timeoutMs);
    const killTimer = setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }, input.timeoutMs + 5_000);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      process.stderr.write(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      rejectProcess(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();

      if (code === 0) {
        resolveProcess(stdout);
        return;
      }

      const reason = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
      rejectProcess(new Error(`scrapling_tool.py failed with ${reason}${stderr ? `: ${stderr}` : ''}`));
    });

    child.stdin.end(input.stdin);
  });
}

async function launchCloakBrowser(input: {
  headed: boolean;
  proxy?: string;
}): Promise<{
  browser: { close: () => Promise<void> };
  cdpHttpUrl: string;
  cdpWebSocketUrl: string;
}> {
  const { launch, ensureBinary } = await import('cloakbrowser');
  const port = await getFreePort();
  const cdpHttpUrl = `http://127.0.0.1:${port}`;
  await ensureBinary();
  const browser = await launch({
    headless: !input.headed,
    humanize: true,
    locale: 'en-US',
    timezone: 'America/New_York',
    proxy: input.proxy,
    args: [
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
    ],
  });
  const cdpWebSocketUrl = await readCdpWebSocketUrl(cdpHttpUrl);
  return { browser, cdpHttpUrl, cdpWebSocketUrl };
}

async function getFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.on('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address !== null) {
          resolvePort(address.port);
          return;
        }
        rejectPort(new Error('Could not allocate a local port'));
      });
    });
  });
}

async function readCdpWebSocketUrl(cdpHttpUrl: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${cdpHttpUrl}/json/version`);
      const body = await response.json() as { webSocketDebuggerUrl?: unknown };
      if (typeof body.webSocketDebuggerUrl === 'string') {
        return body.webSocketDebuggerUrl;
      }
    } catch {
      await new Promise((resolveDelay) => {
        setTimeout(resolveDelay, 100);
      });
    }
  }
  throw new Error(`Could not read CDP websocket URL from ${cdpHttpUrl}`);
}
