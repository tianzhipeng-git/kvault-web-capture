import { resolve } from 'node:path';

import { runIntegrationSpike } from './spike/run-integration-spike.js';

function getArg(flag: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(flag);

  if (index === -1) {
    return fallback;
  }

  return process.argv[index + 1] ?? fallback;
}

function printUsage(): void {
  console.log(
    'Usage: pnpm spike --url <seed-url> [--db ./.local/spike.db] [--storage ./.local/crawlee]',
  );
}

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command !== 'spike') {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const seedUrl = getArg('--url');

  if (!seedUrl) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const dbPath = resolve(getArg('--db', '.local/spike.db')!);
  const storageDir = resolve(getArg('--storage', '.local/crawlee')!);
  const siteName = getArg('--site-name');

  const summary = await runIntegrationSpike({
    dbPath,
    storageDir,
    seedUrl,
    siteName,
  });

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
