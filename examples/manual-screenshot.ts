import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium, type LaunchOptions, type WaitUntilState } from 'playwright';

import { PlaywrightScreenshotCaptureAdapter } from '../src/screenshot/real-screenshot-adapter.js';

const [url, outputPathArg, ...optionArgs] = process.argv.slice(2);

if (!url || !outputPathArg) {
  console.error(
    [
      'Usage: node --import tsx examples/manual-screenshot.ts <url> <output-file>',
      '',
      'Options:',
      '  --timeout-ms <ms>       Navigation timeout. Default: 45000',
      '  --settle-ms <ms>        Extra wait after navigation. Default: 3000',
      '  --wait-until <state>    commit | domcontentloaded | load | networkidle. Default: load',
    ].join('\n'),
  );
  process.exit(1);
}

const optionValue = (name: string): string | undefined => {
  const index = optionArgs.indexOf(name);
  return index === -1 ? undefined : optionArgs[index + 1];
};

const parsePositiveInteger = (name: string, defaultValue: number): number => {
  const rawValue = optionValue(name);
  if (!rawValue) {
    return defaultValue;
  }

  const value = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
};

const waitUntilStates = new Set<WaitUntilState>([
  'commit',
  'domcontentloaded',
  'load',
  'networkidle',
]);

const parseWaitUntil = (): WaitUntilState => {
  const value = optionValue('--wait-until') ?? 'load';
  if (!waitUntilStates.has(value as WaitUntilState)) {
    throw new Error(
      `--wait-until must be one of: ${Array.from(waitUntilStates).join(', ')}`,
    );
  }

  return value as WaitUntilState;
};

const timeoutMs = parsePositiveInteger('--timeout-ms', 45000);
const settleMs = parsePositiveInteger('--settle-ms', 3000);
const waitUntil = parseWaitUntil();
const outputPath = resolve(outputPathArg);
const systemChromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const launchOptions: LaunchOptions = {
  headless: true,
  ...(process.platform === 'darwin' && existsSync(systemChromePath)
    ? { executablePath: systemChromePath }
    : {}),
};

// 奇怪, 和crawler-factory里的HAS_SYSTEM_CHROME写法不一样?

const browser = await chromium.launch(launchOptions);

try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });

  await page.goto(url, { waitUntil, timeout: timeoutMs });
  await page.waitForTimeout(settleMs);

  const adapter = new PlaywrightScreenshotCaptureAdapter();
  const capture = await adapter.capture(url, {
    page,
    finalUrl: page.url(),
  });

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, capture.data);

  console.log(outputPath);
} finally {
  await browser.close();
}
