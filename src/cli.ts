import 'dotenv/config';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { resolve } from 'node:path';

import { CaptureApp } from './app/capture-app.js';
import type { UpdatePolicy } from './domain/types.js';
import type { ProjectExportArtifact } from './export/project-exporter.js';
import { isRunCancelledError } from './utils/cancellation.js';
import { expandLinks } from './utils/link-expander.js';
import { runExtendedCommand } from './cli/extended-commands.js';

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

function hasYesFlag(): boolean {
  return process.argv.includes('--yes');
}

async function promptDeleteConfirmation(message: string): Promise<boolean> {
  if (hasYesFlag()) {
    return true;
  }

  if (!process.stdin.isTTY) {
    throw new Error('删除操作需要交互式确认，请附加 --yes 或在终端中运行。');
  }

  const rl = readline.createInterface({ input, output });

  try {
    const answer = await rl.question(`${message}\n输入 yes 确认删除: `);
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

function installRunSignalHandlers(): {
  abortSignal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();

  const handleSignal = (signal: 'SIGINT' | 'SIGTERM') => {
    if (controller.signal.aborted) {
      return;
    }

    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    console.error(`Received ${signal}, cancelling active run...`);
    controller.abort();
  };
  const handleSigint = () => handleSignal('SIGINT');
  const handleSigterm = () => handleSignal('SIGTERM');

  process.once('SIGINT', handleSigint);
  process.once('SIGTERM', handleSigterm);

  return {
    abortSignal: controller.signal,
    dispose: () => {
      process.removeListener('SIGINT', handleSigint);
      process.removeListener('SIGTERM', handleSigterm);
    },
  };
}

function printUsage(): void {
  console.log(`Usage (recommended; run from the repository root):
  pnpm cli <command> [options]

Equivalent raw commands:
  node --import tsx src/cli.ts project:create --name <name> [--db ./.local/state.db]
  node --import tsx src/cli.ts project:delete --project <project-id> [--yes] [--db ./.local/state.db]
  node --import tsx src/cli.ts project:export --project <project-id> [--output ./.local/exports/project.zip] [--site-ids <id,id>] [--artifacts base,markdown,screenshot,structured] [--status <status,status>] [--db ./.local/state.db]
  node --import tsx src/cli.ts site:export-pages --site <site-id> [--output ./.local/exports/pages.xlsx] [--status <status,status>] [--query <text>] [--label <text>] [--pending-reason <reason>] [--crawl-run-id <run-id>] [--db ./.local/state.db]
  node --import tsx src/cli.ts site:export-pages-by-ids --site <site-id> --page-ids <id,id> [--output ./.local/exports/pages.zip] [--artifacts base,markdown,screenshot,structured] [--db ./.local/state.db]
  node --import tsx src/cli.ts run:export --run <run-id> [--output ./.local/exports/run.zip] [--artifacts base,markdown,screenshot,structured] [--db ./.local/state.db]
  node --import tsx src/cli.ts site:create --project <project-slug> --name <name> --base-url <url> --storage <dir> [--db ./.local/state.db]
  node --import tsx src/cli.ts site:delete --site <site-id> [--yes] [--db ./.local/state.db]
  node --import tsx src/cli.ts site:import-config --site <site-id> --file <config.json> [--db ./.local/state.db]
  node --import tsx src/cli.ts site:clone-config --from-site <site-id> --to-site <site-id> [--db ./.local/state.db]
  node --import tsx src/cli.ts run:seed --site <site-id> [--target-success-count <n>] [--db ./.local/state.db]
  node --import tsx src/cli.ts run:crawl --site <site-id> --update-policy <policy> [--target-success-count <n>] [--stale-after-ms <n>] [--urls <url,url>] [--db ./.local/state.db]
  node --import tsx src/cli.ts run:list --site <site-id> [--type seed_run|crawl_run] [--page <n>] [--page-size <n>] [--db ./.local/state.db]
  node --import tsx src/cli.ts run:get --run <run-id> [--db ./.local/state.db]
  node --import tsx src/cli.ts run:cancel --run <run-id> [--web-url <url> --api-key <key>] [--db ./.local/state.db]
  node --import tsx src/cli.ts run:logs --run <run-id> [--page-id <id>] [--db ./.local/state.db]
  node --import tsx src/cli.ts run:runtime-log --run <run-id> [--tail 500] [--db ./.local/state.db]
  node --import tsx src/cli.ts site:pages --site <site-id> [--status <status,status>] [--query <text>] [--label <text>] [--db ./.local/state.db]
  node --import tsx src/cli.ts site:page --site <site-id> --page-id <id> [--db ./.local/state.db]
  node --import tsx src/cli.ts site:artifact-file --site <site-id> --artifact-run <id> --output <path> [--db ./.local/state.db]
  node --import tsx src/cli.ts site:classification-preview --site <site-id> --page-id <id> [--db ./.local/state.db]
  node --import tsx src/cli.ts project:labels --project <project-id> [--db ./.local/state.db]
  node --import tsx src/cli.ts project:update-labels --project <project-id> --file <labels.json> [--db ./.local/state.db]
  node --import tsx src/cli.ts site:config --site <site-id> [--db ./.local/state.db]
  node --import tsx src/cli.ts site:update-config --site <site-id> --file <config.json> [--db ./.local/state.db]
  node --import tsx src/cli.ts site:rules-preview --site <site-id> --url <url> [--labels-file <labels.json>] [--rules-before-base-file <rules.json>] [--rules-before-stage2-file <rules.json>] [--db ./.local/state.db]
  node --import tsx src/cli.ts system:default-site [--set <site-id|none>] [--db ./.local/state.db]
  node --import tsx src/cli.ts system:default-markdown-site [--set <site-id|none>] [--db ./.local/state.db]
  node --import tsx src/cli.ts system:config [--db ./.local/state.db]
  node --import tsx src/cli.ts system:url-normalization [--strip-query-params <name,name>] [--strip-query-param-prefixes <prefix,prefix>] [--db ./.local/state.db]
  node --import tsx src/cli.ts vault:projects [--key <key>] [--db ./.local/state.db]
  node --import tsx src/cli.ts vault:export-project --project <project-id> --target-project-key <key> [--site-ids <id,id>] [--artifacts <types>] [--status <status,status>] [--db ./.local/state.db]
  node --import tsx src/cli.ts vault:export-run --run <run-id> --target-project-key <key> [--artifacts <types>] [--db ./.local/state.db]
  node --import tsx src/cli.ts vault:export-pages --site <site-id> --page-ids <id,id> --target-project-key <key> [--artifacts <types>] [--db ./.local/state.db]
  node --import tsx src/cli.ts site:inventory-summary --site <site-id> [--db ./.local/state.db]
  node --import tsx src/cli.ts site:path-tree --site <site-id> [--format text|json] [--db ./.local/state.db]
  node --import tsx src/cli.ts site:pending --site <site-id> [--db ./.local/state.db]
  node --import tsx src/cli.ts site:denied --site <site-id> [--db ./.local/state.db]
  node --import tsx src/cli.ts site:sample-captures --site <site-id> [--limit 5] [--db ./.local/state.db]
  node --import tsx src/cli.ts link:expand --url <url>`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const dbPath = resolve(getArg('--db', '.local/state.db')!);

  if (!command) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (command === 'link:expand') {
    console.log(JSON.stringify(await expandLinks(getRequiredArg('--url')), null, 2));
    return;
  }

  const app = await CaptureApp.create({ dbPath, databaseUrl: process.env.KVAULT_DATABASE_URL });

  try {
    if (await runExtendedCommand({
      app,
      command,
      dbPath,
      databaseUrl: process.env.KVAULT_DATABASE_URL,
      argv: process.argv,
    })) {
      return;
    }

    switch (command) {
      case 'project:create': {
        const result = await app.createProject(getRequiredArg('--name'));
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      case 'project:delete': {
        const projectId = Number(getRequiredArg('--project'));
        const summary = await app.getProjectDeletionSummary(projectId);
        const confirmed = await promptDeleteConfirmation(
          [
            `即将删除项目「${summary.projectName}」(${summary.projectSlug})。`,
            `包含 ${summary.siteCount} 个站点，以及所有页面、运行记录和数据库数据。`,
            '本地 storage 目录不会被自动删除。',
          ].join('\n'),
        );

        if (!confirmed) {
          console.log(JSON.stringify({ status: 'cancelled' }, null, 2));
          return;
        }

        await app.deleteProject(projectId);
        console.log(JSON.stringify({ status: 'ok', projectId }, null, 2));
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
      case 'site:delete': {
        const siteId = Number(getRequiredArg('--site'));
        const summary = await app.getSiteDeletionSummary(siteId);
        const confirmed = await promptDeleteConfirmation(
          [
            `即将删除站点「${summary.siteName}」。`,
            `Base URL: ${summary.baseUrl}`,
            `Storage: ${summary.storageRoot}`,
            '将删除该站点的所有页面、运行记录和数据库数据。',
            '本地 storage 目录不会被自动删除。',
          ].join('\n'),
        );

        if (!confirmed) {
          console.log(JSON.stringify({ status: 'cancelled' }, null, 2));
          return;
        }

        await app.deleteSite(siteId);
        console.log(JSON.stringify({ status: 'ok', siteId }, null, 2));
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
        const cancellation = installRunSignalHandlers();
        try {
          const result = await app.runSeed({
            siteId: Number(getRequiredArg('--site')),
            targetSuccessCount: targetSuccessCount ? Number(targetSuccessCount) : null,
            abortSignal: cancellation.abortSignal,
          });
          console.log(JSON.stringify(result, null, 2));
        } finally {
          cancellation.dispose();
        }
        return;
      }
      case 'run:crawl': {
        const updatePolicy = getRequiredArg('--update-policy') as UpdatePolicy;
        const targetSuccessCount = getArg('--target-success-count');
        const staleAfterMs = getArg('--stale-after-ms');
        const cancellation = installRunSignalHandlers();
        try {
          const result = await app.runCrawl({
            siteId: Number(getRequiredArg('--site')),
            updatePolicy,
            targetSuccessCount: targetSuccessCount ? Number(targetSuccessCount) : null,
            staleAfterMs: staleAfterMs ? Number(staleAfterMs) : null,
            initialUrls: getArgList('--urls'),
            crawlMaxDepthOverride: getArgList('--urls') ? 0 : null,
            abortSignal: cancellation.abortSignal,
          });
          console.log(JSON.stringify(result, null, 2));
        } finally {
          cancellation.dispose();
        }
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
    if (isRunCancelledError(error)) {
      console.error(error.message);
      process.exitCode ??= 1;
      return;
    }

    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(process.exitCode ?? 0);
  });
