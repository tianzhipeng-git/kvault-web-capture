import 'dotenv/config';
import { resolve } from 'node:path';

import { M1App } from './app/services.js';
import { runIntegrationSpike } from './spike/run-integration-spike.js';
import type { UpdatePolicy } from './domain/types.js';

function getArg(flag: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(flag);

  if (index === -1) {
    return fallback;
  }

  return process.argv[index + 1] ?? fallback;
}

function getRequiredArg(flag: string): string {
  const value = getArg(flag);

  if (!value) {
    throw new Error(`Missing required flag ${flag}`);
  }

  return value;
}

function printUsage(): void {
  console.log(`Usage:
  pnpm spike --url <seed-url> [--db ./.local/spike.db] [--storage ./.local/crawlee]
  node --import tsx src/cli.ts project:create --name <name> [--db ./.local/state.db]
  node --import tsx src/cli.ts site:create --project <project-slug> --name <name> --base-url <url> --storage <dir> [--db ./.local/state.db]
  node --import tsx src/cli.ts site:import-config --site <site-id> --file <config.json> [--db ./.local/state.db]
  node --import tsx src/cli.ts site:clone-config --from-site <site-id> --to-site <site-id> [--db ./.local/state.db]
  node --import tsx src/cli.ts run:seed --site <site-id> [--db ./.local/state.db]
  node --import tsx src/cli.ts run:crawl --site <site-id> --update-policy <policy> [--target-success-count <n>] [--stale-after-ms <n>] [--db ./.local/state.db]
  node --import tsx src/cli.ts site:inventory-summary --site <site-id> [--db ./.local/state.db]
  node --import tsx src/cli.ts site:pending --site <site-id> [--db ./.local/state.db]
  node --import tsx src/cli.ts site:denied --site <site-id> [--db ./.local/state.db]
  node --import tsx src/cli.ts site:sample-captures --site <site-id> [--limit 5] [--db ./.local/state.db]`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const dbPath = resolve(getArg('--db', '.local/state.db')!);

  if (!command) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (command === 'spike') {
    const seedUrl = getRequiredArg('--url');
    const storageDir = resolve(getArg('--storage', '.local/crawlee')!);
    const siteName = getArg('--site-name');

    const summary = await runIntegrationSpike({
      dbPath,
      storageDir,
      seedUrl,
      siteName,
    });

    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const app = new M1App({ dbPath });

  try {
    switch (command) {
      case 'project:create': {
        const result = app.createProject(getRequiredArg('--name'));
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      case 'site:create': {
        const result = app.createSite({
          projectSlug: getRequiredArg('--project'),
          name: getRequiredArg('--name'),
          baseUrl: getRequiredArg('--base-url'),
          storageRoot: resolve(getRequiredArg('--storage')),
        });
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      case 'site:import-config': {
        app.importSiteConfig(Number(getRequiredArg('--site')), resolve(getRequiredArg('--file')));
        console.log(JSON.stringify({ status: 'ok' }, null, 2));
        return;
      }
      case 'site:clone-config': {
        app.cloneSiteConfig(
          Number(getRequiredArg('--from-site')),
          Number(getRequiredArg('--to-site')),
        );
        console.log(JSON.stringify({ status: 'ok' }, null, 2));
        return;
      }
      case 'run:seed': {
        const result = await app.runSeed(Number(getRequiredArg('--site')));
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      case 'run:crawl': {
        const updatePolicy = getRequiredArg('--update-policy') as UpdatePolicy;
        const targetSuccessCount = getArg('--target-success-count');
        const staleAfterMs = getArg('--stale-after-ms');
        const result = await app.runCrawl({
          siteId: Number(getRequiredArg('--site')),
          updatePolicy,
          targetSuccessCount: targetSuccessCount ? Number(targetSuccessCount) : null,
          staleAfterMs: staleAfterMs ? Number(staleAfterMs) : null,
        });
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      case 'site:inventory-summary': {
        console.log(
          JSON.stringify(app.getInventorySummary(Number(getRequiredArg('--site'))), null, 2),
        );
        return;
      }
      case 'site:pending': {
        console.log(JSON.stringify(app.listPendingPages(Number(getRequiredArg('--site'))), null, 2));
        return;
      }
      case 'site:denied': {
        console.log(JSON.stringify(app.listDeniedPages(Number(getRequiredArg('--site'))), null, 2));
        return;
      }
      case 'site:sample-captures': {
        console.log(
          JSON.stringify(
            app.listSampleCaptures(
              Number(getRequiredArg('--site')),
              Number(getArg('--limit', '5')),
            ),
            null,
            2,
          ),
        );
        return;
      }
      default:
        printUsage();
        process.exitCode = 1;
    }
  } finally {
    app.close();
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(process.exitCode ?? 0);
  });
