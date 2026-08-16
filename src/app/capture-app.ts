import type { Classifier } from '../classification/classifier.js';
import type { CaptureTool } from '../capture/types.js';
import { initializeSchema, openDatabase, type DbClient } from '../db/database.js';
import {
  ArtifactRunRepository,
  DeletionRepository,
  PageRunRepository,
  ProjectRepository,
  RunLogRepository,
  RunRepository,
  SitePageRepository,
  SiteRepository,
  SystemSettingRepository,
} from '../db/repositories/index.js';
import { DeletionService } from './deletion-service.js';
import type { RunSummary, SiteConfig, UpdatePolicy, UrlNormalizationConfig } from '../domain/types.js';
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
    private readonly deletions: DeletionService,
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
    const deletions = new DeletionRepository(db);
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
        systemSettings,
        planner,
        options,
      ),
      new DeletionService(projects, sites, runs, deletions, systemSettings),
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

  getProjectDeletionSummary(projectId: number) {
    return this.deletions.getProjectDeletionSummary(projectId);
  }

  deleteProject(projectId: number) {
    return this.deletions.deleteProject(projectId);
  }

  getSiteDeletionSummary(siteId: number) {
    return this.deletions.getSiteDeletionSummary(siteId);
  }

  deleteSite(siteId: number) {
    return this.deletions.deleteSite(siteId);
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

  fetchSiteFavicon(siteId: number) {
    return this.sites.fetchFavicon(siteId);
  }

  getSiteFavicon(siteId: number) {
    return this.sites.getFavicon(siteId);
  }

  previewPageClassification(siteId: number, sitePageId: number) {
    return this.runs.previewClassification(siteId, sitePageId);
  }

  getDefaultSite() {
    return this.sites.getDefaultSite();
  }

  setDefaultSite(siteId: number | null) {
    return this.sites.setDefaultSite(siteId);
  }

  getDefaultMarkdownSite() {
    return this.sites.getDefaultMarkdownSite();
  }

  setDefaultMarkdownSite(siteId: number | null) {
    return this.sites.setDefaultMarkdownSite(siteId);
  }

  getSystemConfig() {
    return this.sites.getSystemConfig();
  }

  updateSystemUrlNormalization(config: UrlNormalizationConfig) {
    return this.sites.updateSystemUrlNormalization(config);
  }

  runSeed(input: number | {
    siteId: number;
    targetSuccessCount: number | null;
    abortSignal?: AbortSignal;
  }): Promise<RunSummary> {
    return this.runs.runSeed(input);
  }

  runCrawl(input: {
    siteId: number;
    updatePolicy: UpdatePolicy;
    skipBase?: boolean;
    targetSuccessCount: number | null;
    staleAfterMs: number | null;
    initialUrls?: string[] | null;
    crawlMaxDepthOverride?: number | null;
    abortSignal?: AbortSignal;
  }): Promise<RunSummary> {
    return this.runs.runCrawl(input);
  }

  cancelOrphanRun(runId: number): Promise<boolean> {
    return this.runs.cancelOrphanRun(runId);
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
