import type { Classifier } from '../classification/classifier.js';
import type { CaptureTool } from '../capture/types.js';
import { initializeSchema, openDatabase, type DbClient } from '../db/database.js';
import {
  ArtifactRunRepository,
  PageRunRepository,
  ProjectRepository,
  RunLogRepository,
  RunRepository,
  SitePageRepository,
  SiteRepository,
  SystemSettingRepository,
} from '../db/repositories/index.js';
import type { RunSummary, SiteConfig, UpdatePolicy } from '../domain/types.js';
import {
  ProjectExporter,
  type ProjectExportOptions,
  type ProjectExportResult,
  type SitePageIdExportInput,
  type SitePageIdExportResult,
  type SitePageListExportInput,
  type SitePageListExportResult,
} from '../export/project-exporter.js';
import { RunPlanner } from '../planner/run-planner.js';
import { SystemClock } from '../utils/clock.js';
import { ProjectService } from './project-service.js';
import { RunService, type RunNotificationBot } from './run-service.js';
import { SiteService } from './site-service.js';

export interface CaptureAppOptions {
  dbPath: string;
  databaseUrl?: string;
  classifier?: Classifier;
  captureTools?: CaptureTool[];
  feishuBot?: RunNotificationBot | null;
}

export class CaptureApp {
  private constructor(
    private readonly db: DbClient,
    private readonly projects: ProjectService,
    private readonly sites: SiteService,
    private readonly runs: RunService,
    private readonly projectExporter: ProjectExporter,
  ) {}

  static async create(options: CaptureAppOptions): Promise<CaptureApp> {
    const db = await openDatabase({ path: options.dbPath, url: options.databaseUrl });
    const clock = new SystemClock();
    const projects = new ProjectRepository(db, clock);
    const sites = new SiteRepository(db, clock);
    const runs = new RunRepository(db, clock);
    const sitePages = new SitePageRepository(db, clock);
    const pageRuns = new PageRunRepository(db, clock);
    const artifactRuns = new ArtifactRunRepository(db, clock);
    const runLogs = new RunLogRepository(db, clock);
    const systemSettings = new SystemSettingRepository(db, clock);
    const planner = new RunPlanner(sitePages, clock);

    await initializeSchema(db);

    return new CaptureApp(
      db,
      new ProjectService(projects),
      new SiteService(projects, sites, sitePages, pageRuns, systemSettings),
      new RunService(
        projects,
        sites,
        runs,
        sitePages,
        pageRuns,
        artifactRuns,
        runLogs,
        planner,
        options,
      ),
      new ProjectExporter(db, clock),
    );
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  createProject(name: string) {
    return this.projects.createProject(name);
  }

  getProjectLabelDefinitions(projectId: number) {
    return this.projects.getLabelDefinitions(projectId);
  }

  updateProjectLabelDefinitions(projectId: number, labelDefinitions: unknown) {
    return this.projects.updateLabelDefinitions(projectId, labelDefinitions);
  }

  createSite(input: {
    projectId?: number;
    projectSlug?: string;
    name: string;
    baseUrl: string;
    storageRoot: string;
  }) {
    return this.sites.createSite(input);
  }

  importSiteConfig(siteId: number, configPath: string) {
    return this.sites.importConfig(siteId, configPath);
  }

  cloneSiteConfig(sourceSiteId: number, targetSiteId: number) {
    return this.sites.cloneConfig(sourceSiteId, targetSiteId);
  }

  getSiteConfig(siteId: number) {
    return this.sites.getConfig(siteId);
  }

  updateSiteConfig(siteId: number, config: SiteConfig) {
    return this.sites.updateConfig(siteId, config);
  }

  getDefaultSite() {
    return this.sites.getDefaultSite();
  }

  setDefaultSite(siteId: number | null) {
    return this.sites.setDefaultSite(siteId);
  }

  runSeed(input: number | { siteId: number; targetSuccessCount: number | null }): Promise<RunSummary> {
    return this.runs.runSeed(input);
  }

  runCrawl(input: {
    siteId: number;
    updatePolicy: UpdatePolicy;
    targetSuccessCount: number | null;
    staleAfterMs: number | null;
    initialUrls?: string[] | null;
    crawlMaxDepthOverride?: number | null;
  }): Promise<RunSummary> {
    return this.runs.runCrawl(input);
  }

  getInventorySummary(siteId: number) {
    return this.sites.getInventorySummary(siteId);
  }

  listPendingPages(siteId: number) {
    return this.sites.listPendingPages(siteId);
  }

  listDeniedPages(siteId: number) {
    return this.sites.listDeniedPages(siteId);
  }

  getSitePathTree(siteId: number) {
    return this.sites.getPathTree(siteId);
  }

  listSampleCaptures(siteId: number, limit: number) {
    return this.sites.listSampleCaptures(siteId, limit);
  }

  exportProject(
    projectId: number,
    outputPath?: string,
    options?: ProjectExportOptions,
  ): Promise<ProjectExportResult> {
    return this.projectExporter.exportProject({ projectId, outputPath, options });
  }

  exportSitePageList(input: SitePageListExportInput): Promise<SitePageListExportResult> {
    return this.projectExporter.exportSitePageList(input);
  }

  exportSitePagesByIds(input: SitePageIdExportInput): Promise<SitePageIdExportResult> {
    return this.projectExporter.exportSitePagesByIds(input);
  }

  exportRunPages(
    runId: number,
    artifacts?: ProjectExportOptions['artifacts'],
    outputPath?: string,
  ): Promise<SitePageIdExportResult & { runId: number }> {
    return this.projectExporter.exportRunPages({ runId, artifacts, outputPath });
  }
}
