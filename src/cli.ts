import 'dotenv/config';
import { resolve } from 'node:path';

import { CaptureApp } from './app/capture-app.js';
import type { UpdatePolicy } from './domain/types.js';
import type { ProjectExportArtifact } from './export/project-exporter.js';

const exportArtifacts = new Set<ProjectExportArtifact>(['base', 'markdown', 'screenshot', 'structured']);

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

function getArgList(flag: string): string[] | undefined {
  const value = getArg(flag);
  if (!value) {
    return undefined;
  }

  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return items.length > 0 ? items : undefined;
}

function getArgNumberList(flag: string): number[] | undefined {
  const items = getArgList(flag);
  if (!items) {
    return undefined;
  }

  const numbers = items.map((item) => Number(item));
  if (numbers.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new Error(`${flag} contains invalid numeric values`);
  }

  return numbers;
}

function parseExportArtifactList(flag: string): ProjectExportArtifact[] | undefined {
  const items = getArgList(flag);
  if (!items) {
    return undefined;
  }

  const artifacts = items.filter((item): item is ProjectExportArtifact => exportArtifacts.has(item as ProjectExportArtifact));
  if (artifacts.length !== items.length) {
    throw new Error(`${flag} must be a comma-separated list of base, markdown, screenshot, structured`);
  }

  return artifacts;
}

function parseStatusList(flag: string): string[] | undefined {
  return getArgList(flag);
}

function printUsage(): void {
  console.log(`Usage:
  node --import tsx src/cli.ts project:create --name <name> [--db ./.local/state.db]
  node --import tsx src/cli.ts project:export --project <project-id> [--output ./.local/exports/project.zip] [--site-ids <id,id>] [--artifacts base,markdown,screenshot,structured] [--status <status,status>] [--db ./.local/state.db]
  node --import tsx src/cli.ts site:export-pages --site <site-id> [--output ./.local/exports/pages.xlsx] [--status <status,status>] [--query <text>] [--label <text>] [--pending-reason <reason>] [--crawl-run-id <run-id>] [--db ./.local/state.db]
  node --import tsx src/cli.ts site:export-pages-by-ids --site <site-id> --page-ids <id,id> [--output ./.local/exports/pages.zip] [--artifacts base,markdown,screenshot,structured] [--db ./.local/state.db]
  node --import tsx src/cli.ts run:export --run <run-id> [--output ./.local/exports/run.zip] [--artifacts base,markdown,screenshot,structured] [--db ./.local/state.db]
  node --import tsx src/cli.ts site:create --project <project-slug> --name <name> --base-url <url> --storage <dir> [--db ./.local/state.db]
  node --import tsx src/cli.ts site:import-config --site <site-id> --file <config.json> [--db ./.local/state.db]
  node --import tsx src/cli.ts site:clone-config --from-site <site-id> --to-site <site-id> [--db ./.local/state.db]
  node --import tsx src/cli.ts run:seed --site <site-id> [--target-success-count <n>] [--db ./.local/state.db]
  node --import tsx src/cli.ts run:crawl --site <site-id> --update-policy <policy> [--target-success-count <n>] [--stale-after-ms <n>] [--db ./.local/state.db]
  node --import tsx src/cli.ts site:inventory-summary --site <site-id> [--db ./.local/state.db]
  node --import tsx src/cli.ts site:path-tree --site <site-id> [--format text|json] [--db ./.local/state.db]
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

  const app = await CaptureApp.create({ dbPath, databaseUrl: process.env.KVAULT_DATABASE_URL });

  try {
    switch (command) {
      case 'project:create': {
        const result = await app.createProject(getRequiredArg('--name'));
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      case 'project:export': {
        const output = getArg('--output');
        const siteIds = getArgNumberList('--site-ids');
        const artifacts = parseExportArtifactList('--artifacts');
        const status = parseStatusList('--status');
        const result = await app.exportProject(
          Number(getRequiredArg('--project')),
          output ? resolve(output) : undefined,
          {
            ...(siteIds ? { siteIds } : {}),
            ...(artifacts ? { artifacts } : {}),
            ...(status ? { status } : {}),
          },
        );
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      case 'site:export-pages': {
        const output = getArg('--output');
        const crawlRunId = getArg('--crawl-run-id');
        const result = await app.exportSitePageList({
          siteId: Number(getRequiredArg('--site')),
          outputPath: output ? resolve(output) : undefined,
          status: parseStatusList('--status'),
          query: getArg('--query'),
          label: getArg('--label'),
          pendingReason: getArg('--pending-reason'),
          crawlRunId: crawlRunId ? Number(crawlRunId) : undefined,
        });
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      case 'site:export-pages-by-ids': {
        const output = getArg('--output');
        const pageIds = getArgNumberList('--page-ids');
        if (!pageIds) {
          throw new Error('Missing required flag --page-ids');
        }
        const result = await app.exportSitePagesByIds({
          siteId: Number(getRequiredArg('--site')),
          pageIds,
          outputPath: output ? resolve(output) : undefined,
          artifacts: parseExportArtifactList('--artifacts'),
        });
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      case 'run:export': {
        const output = getArg('--output');
        const result = await app.exportRunPages(
          Number(getRequiredArg('--run')),
          parseExportArtifactList('--artifacts'),
          output ? resolve(output) : undefined,
        );
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      case 'site:create': {
        const result = await app.createSite({
          projectSlug: getRequiredArg('--project'),
          name: getRequiredArg('--name'),
          baseUrl: getRequiredArg('--base-url'),
          storageRoot: resolve(getRequiredArg('--storage')),
        });
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      case 'site:import-config': {
        await app.importSiteConfig(Number(getRequiredArg('--site')), resolve(getRequiredArg('--file')));
        console.log(JSON.stringify({ status: 'ok' }, null, 2));
        return;
      }
      case 'site:clone-config': {
        await app.cloneSiteConfig(
          Number(getRequiredArg('--from-site')),
          Number(getRequiredArg('--to-site')),
        );
        console.log(JSON.stringify({ status: 'ok' }, null, 2));
        return;
      }
      case 'run:seed': {
        const targetSuccessCount = getArg('--target-success-count');
        const result = await app.runSeed({
          siteId: Number(getRequiredArg('--site')),
          targetSuccessCount: targetSuccessCount ? Number(targetSuccessCount) : null,
        });
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
          JSON.stringify(await app.getInventorySummary(Number(getRequiredArg('--site'))), null, 2),
        );
        return;
      }
      case 'site:path-tree': {
        const format = getArg('--format', 'text');
        const result = await app.getSitePathTree(Number(getRequiredArg('--site')));

        if (format === 'json') {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (format === 'text') {
          console.log(result.text);
          return;
        }

        throw new Error('--format must be text or json');
      }
      case 'site:pending': {
        console.log(JSON.stringify(await app.listPendingPages(Number(getRequiredArg('--site'))), null, 2));
        return;
      }
      case 'site:denied': {
        console.log(JSON.stringify(await app.listDeniedPages(Number(getRequiredArg('--site'))), null, 2));
        return;
      }
      case 'site:sample-captures': {
        console.log(
          JSON.stringify(
            await app.listSampleCaptures(
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
    await app.close();
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
