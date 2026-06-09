import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { launch, ensureBinary } from 'cloakbrowser';
import { Defuddle } from 'defuddle/node';
import { parseHTML } from 'linkedom';

const [url, outputPathArg, ...optionArgs] = process.argv.slice(2);

if (!url) {
  console.error(
    [
      'Usage: node --import tsx examples/cloakbrowser-markdown-smoke.ts <url> [output-file]',
      '',
      'Options:',
      '  --settle-ms <ms>  Extra native sleep after navigation. Default: 2000',
      '  --headed         Show the CloakBrowser window',
    ].join('\n'),
  );
  process.exit(1);
}

const hasFlag = (name: string): boolean => optionArgs.includes(name);

const optionValue = (name: string): string | undefined => {
  const index = optionArgs.indexOf(name);
  return index === -1 ? undefined : optionArgs[index + 1];
};

const parseNonNegativeInteger = (name: string, defaultValue: number): number => {
  const rawValue = optionValue(name);
  if (!rawValue) {
    return defaultValue;
  }

  const value = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return value;
};

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => {
  setTimeout(resolveSleep, ms);
});

const settleMs = parseNonNegativeInteger('--settle-ms', 2000);

await ensureBinary();

const browser = await launch({
  headless: !hasFlag('--headed'),
});

try {
  const page = await browser.newPage();

  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });

  if (settleMs > 0) {
    await sleep(settleMs);
  }

  const finalUrl = page.url();
  const html = await page.content();
  const { document } = parseHTML(html);
  const result = await Defuddle(document, finalUrl, {
    markdown: true,
    useAsync: false,
  });
  const markdown = (result.content ?? '').trim();

  if (!markdown) {
    throw new Error('Defuddle returned empty markdown');
  }

  if (outputPathArg) {
    const outputPath = resolve(outputPathArg);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${markdown}\n`, 'utf8');
    console.log(outputPath);
  } else {
    console.log(markdown);
  }
} finally {
  await browser.close();
}
