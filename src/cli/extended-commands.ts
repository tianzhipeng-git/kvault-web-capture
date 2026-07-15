import { copyFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { CaptureApp } from '../app/capture-app.js';
import { openDatabase } from '../db/database.js';
import type { SiteConfig, UpdatePolicy } from '../domain/types.js';
import type { ProjectExportArtifact } from '../export/project-exporter.js';
import { buildBaseEnqueueDecision, buildStage2EnqueueDecision } from '../rules/rule-decision.js';
import {
  RunLogQuery,
  RunSummaryQuery,
  SitePageDetailQuery,
  SitePageListQuery,
} from '../web/queries/read-models.js';
import { VaultExportManager } from '../web/services/vault-export-manager.js';

const exportArtifacts = new Set<ProjectExportArtifact>(['base', 'markdown', 'screenshot', 'structured']);

interface ExtendedCommandInput {
  app: CaptureApp;
  command: string;
  dbPath: string;
  databaseUrl?: string;
  argv: string[];
}

function getArg(argv: string[], flag: string, fallback?: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : argv[index + 1] ?? fallback;
}

function requiredArg(argv: string[], flag: string): string {
  const value = getArg(argv, flag);
  if (!value) throw new Error(`Missing required flag ${flag}`);
  return value;
}

function positiveId(argv: string[], flag: string): number {
  const value = Number(requiredArg(argv, flag));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} must be a positive integer`);
  return value;
}

function optionalPositiveInt(argv: string[], flag: string, fallback: number): number {
  const raw = getArg(argv, flag);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} must be a positive integer`);
  return value;
}

function tailLines(argv: string[]): number {
  const raw = getArg(argv, '--tail');
  if (raw === undefined) return 500;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 5000) {
    throw new Error('--tail must be an integer between 0 and 5000');
  }
  return value;
}

function runType(argv: string[]): 'seed_run' | 'crawl_run' | undefined {
  const value = getArg(argv, '--type');
  if (value === undefined) return undefined;
  if (value !== 'seed_run' && value !== 'crawl_run') {
    throw new Error('--type must be seed_run or crawl_run');
  }
  return value;
}

function listArg(argv: string[], flag: string): string[] | undefined {
  const value = getArg(argv, flag);
  if (!value) return undefined;
  const items = value.split(',').map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function artifacts(argv: string[]): ProjectExportArtifact[] | undefined {
  const values = listArg(argv, '--artifacts');
  if (!values) return undefined;
  if (values.some((value) => !exportArtifacts.has(value as ProjectExportArtifact))) {
    throw new Error('--artifacts must be a comma-separated list of base, markdown, screenshot, structured');
  }
  return values as ProjectExportArtifact[];
}

async function readJsonFile<T>(argv: string[], flag: string): Promise<T> {
  const path = resolve(requiredArg(argv, flag));
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function waitForVaultTask(manager: VaultExportManager, taskId: string) {
  while (true) {
    const task = manager.getSnapshot();
    if (!task || task.taskId !== taskId) throw new Error('Vault export task disappeared');
    if (task.phase === 'succeeded' || task.phase === 'failed') return task;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
}

async function exportToVault(
  manager: VaultExportManager,
  targetProjectKey: string,
  exportZip: () => Promise<
    Awaited<ReturnType<CaptureApp['exportProject']>>
    | Awaited<ReturnType<CaptureApp['exportRunPages']>>
    | Awaited<ReturnType<CaptureApp['exportSitePagesByIds']>>
  >,
): Promise<void> {
  const task = manager.start({ targetProjectKey, exportZip });
  const result = await waitForVaultTask(manager, task.taskId);
  print(result);
  if (result.phase === 'failed') throw new Error(result.errorMessage ?? 'Vault export failed');
}

export async function runExtendedCommand(input: ExtendedCommandInput): Promise<boolean> {
  const { app, command, argv } = input;
  const supported = new Set([
    'run:list', 'run:get', 'run:cancel', 'run:logs', 'run:runtime-log',
    'site:pages', 'site:page', 'site:artifact-file', 'site:classification-preview',
    'project:labels', 'project:update-labels', 'site:config', 'site:update-config', 'site:rules-preview',
    'system:default-site', 'system:default-markdown-site', 'system:config', 'system:url-normalization',
    'vault:projects', 'vault:export-project', 'vault:export-run', 'vault:export-pages',
  ]);
  if (!supported.has(command)) return false;

  const db = await openDatabase({ path: input.dbPath, url: input.databaseUrl });
  try {
    const runQuery = new RunSummaryQuery(db);
    const logQuery = new RunLogQuery(db);
    const pageQuery = new SitePageListQuery(db);
    const detailQuery = new SitePageDetailQuery(db);

    switch (command) {
      case 'run:list':
        print(await runQuery.listSiteRuns({
          siteId: positiveId(argv, '--site'),
          page: optionalPositiveInt(argv, '--page', 1),
          pageSize: optionalPositiveInt(argv, '--page-size', 20),
          runType: runType(argv),
        }));
        return true;
      case 'run:get':
        print(await runQuery.getRunSummary(positiveId(argv, '--run')));
        return true;
      case 'run:cancel': {
        const runId = positiveId(argv, '--run');
        const webUrl = getArg(argv, '--web-url');
        if (webUrl) {
          const apiKey = getArg(argv, '--api-key') ?? process.env.KVAULT_API_KEY;
          const response = await fetch(`${webUrl.replace(/\/$/, '')}/api/runs/${runId}/cancel`, {
            method: 'POST',
            headers: apiKey ? { 'x-api-key': apiKey } : undefined,
          });
          const result = await response.json() as unknown;
          if (!response.ok) {
            const message = typeof result === 'object' && result !== null && 'message' in result
              ? String(result.message)
              : `Web server returned ${response.status}`;
            throw new Error(message);
          }
          print(result);
          return true;
        }
        if (!await app.cancelOrphanRun(runId)) throw new Error('Run is not running or belongs to an active worker.');
        print({ status: 'cancelled', runId });
        return true;
      }
      case 'run:logs':
        print({
          items: await logQuery.listRunLogs(
            positiveId(argv, '--run'),
            getArg(argv, '--page-id') ? positiveId(argv, '--page-id') : undefined,
          ),
          errorMessage: await logQuery.getRunErrorMessage(positiveId(argv, '--run')),
        });
        return true;
      case 'run:runtime-log': {
        const runtimeLog = await logQuery.getRuntimeLog(
          positiveId(argv, '--run'),
          tailLines(argv),
        );
        if (!runtimeLog) throw new Error('Run has no runtime log.');
        print(runtimeLog);
        return true;
      }
      case 'site:pages':
        print(await pageQuery.listPages({
          siteId: positiveId(argv, '--site'),
          page: optionalPositiveInt(argv, '--page', 1),
          pageSize: optionalPositiveInt(argv, '--page-size', 20),
          status: listArg(argv, '--status'),
          query: getArg(argv, '--query'),
          label: getArg(argv, '--label'),
          pendingReason: getArg(argv, '--pending-reason'),
          discoverySource: getArg(argv, '--discovery-source'),
          crawlRunId: getArg(argv, '--crawl-run-id') ? positiveId(argv, '--crawl-run-id') : undefined,
        }));
        return true;
      case 'site:page':
        print(await detailQuery.getPageDetail(positiveId(argv, '--site'), positiveId(argv, '--page-id')));
        return true;
      case 'site:artifact-file': {
        const artifact = await detailQuery.getArtifactFile(
          positiveId(argv, '--site'), positiveId(argv, '--artifact-run'),
        );
        const outputPath = resolve(requiredArg(argv, '--output'));
        await copyFile(artifact.outputPath, outputPath);
        print({ ...artifact, outputPath });
        return true;
      }
      case 'site:classification-preview':
        print(await app.previewPageClassification(positiveId(argv, '--site'), positiveId(argv, '--page-id')));
        return true;
      case 'project:labels':
        print(await app.getProjectLabelDefinitions(positiveId(argv, '--project')));
        return true;
      case 'project:update-labels':
        await app.updateProjectLabelDefinitions(positiveId(argv, '--project'), await readJsonFile(argv, '--file'));
        print({ status: 'ok' });
        return true;
      case 'site:config':
        print(await app.getSiteConfig(positiveId(argv, '--site')));
        return true;
      case 'site:update-config':
        await app.updateSiteConfig(positiveId(argv, '--site'), await readJsonFile<SiteConfig>(argv, '--file'));
        print({ status: 'ok' });
        return true;
      case 'site:rules-preview': {
        const siteId = positiveId(argv, '--site');
        const savedConfig = await app.getSiteConfig(siteId);
        const config = {
          ...savedConfig,
          ...(getArg(argv, '--rules-before-base-file')
            ? { rulesBeforeBaseEq: await readJsonFile<SiteConfig['rulesBeforeBaseEq']>(argv, '--rules-before-base-file') }
            : {}),
          ...(getArg(argv, '--rules-before-stage2-file')
            ? { rulesBeforeStage2Eq: await readJsonFile<SiteConfig['rulesBeforeStage2Eq']>(argv, '--rules-before-stage2-file') }
            : {}),
        };
        const labels = getArg(argv, '--labels-file')
          ? await readJsonFile<Record<string, string[]>>(argv, '--labels-file')
          : null;
        print({
          baseDecision: buildBaseEnqueueDecision({ url: requiredArg(argv, '--url'), siteConfig: config }),
          stage2Decision: buildStage2EnqueueDecision({
            runType: 'crawl_run', url: requiredArg(argv, '--url'), siteConfig: config,
            classification: labels ? { labels } : null,
          }),
        });
        return true;
      }
      case 'system:default-site': {
        const siteId = getArg(argv, '--set');
        if (siteId !== undefined) await app.setDefaultSite(siteId === 'none' ? null : positiveId(argv, '--set'));
        print({ defaultSite: await app.getDefaultSite() });
        return true;
      }
      case 'system:default-markdown-site': {
        const siteId = getArg(argv, '--set');
        if (siteId !== undefined) await app.setDefaultMarkdownSite(siteId === 'none' ? null : positiveId(argv, '--set'));
        print({ defaultSite: await app.getDefaultMarkdownSite() });
        return true;
      }
      case 'system:config':
        print(await app.getSystemConfig());
        return true;
      case 'system:url-normalization': {
        const params = listArg(argv, '--strip-query-params');
        const prefixes = listArg(argv, '--strip-query-param-prefixes');
        if (params || prefixes) await app.updateSystemUrlNormalization({
          stripQueryParams: params ?? (await app.getSystemConfig()).urlNormalization.stripQueryParams,
          stripQueryParamPrefixes: prefixes ?? (await app.getSystemConfig()).urlNormalization.stripQueryParamPrefixes,
        });
        print(await app.getSystemConfig());
        return true;
      }
      case 'vault:projects': {
        const manager = new VaultExportManager();
        print(getArg(argv, '--key') ? await manager.findTargetProjects(requiredArg(argv, '--key')) : await manager.listTargetProjects());
        return true;
      }
      case 'vault:export-project': {
        const manager = new VaultExportManager();
        await exportToVault(manager, requiredArg(argv, '--target-project-key'), () => app.exportProject(
          positiveId(argv, '--project'), undefined, {
            ...(listArg(argv, '--site-ids') ? { siteIds: listArg(argv, '--site-ids')!.map(Number) } : {}),
            ...(artifacts(argv) ? { artifacts: artifacts(argv) } : {}),
            ...(listArg(argv, '--status') ? { status: listArg(argv, '--status') } : {}),
          },
        ));
        return true;
      }
      case 'vault:export-run': {
        const manager = new VaultExportManager();
        await exportToVault(manager, requiredArg(argv, '--target-project-key'), () => app.exportRunPages(
          positiveId(argv, '--run'), artifacts(argv),
        ));
        return true;
      }
      case 'vault:export-pages': {
        const manager = new VaultExportManager();
        const pageIds = listArg(argv, '--page-ids')?.map(Number);
        if (!pageIds?.length || pageIds.some((id) => !Number.isInteger(id) || id <= 0)) {
          throw new Error('--page-ids must be a comma-separated list of positive integers');
        }
        await exportToVault(manager, requiredArg(argv, '--target-project-key'), () => app.exportSitePagesByIds({
          siteId: positiveId(argv, '--site'), pageIds, artifacts: artifacts(argv),
        }));
        return true;
      }
    }

    return true;
  } finally {
    await db.close();
  }
}
