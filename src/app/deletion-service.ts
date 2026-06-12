import type {
  DeletionRepository,
  ProjectRepository,
  RunRepository,
  SiteRepository,
  SystemSettingRepository,
} from '../db/repositories/index.js';

export interface SiteDeletionSummary {
  siteId: number;
  siteName: string;
  baseUrl: string;
  storageRoot: string;
  projectId: number;
}

export interface ProjectDeletionSummary {
  projectId: number;
  projectName: string;
  projectSlug: string;
  siteCount: number;
  sites: SiteDeletionSummary[];
}

export class DeletionService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly sites: SiteRepository,
    private readonly runs: RunRepository,
    private readonly deletions: DeletionRepository,
    private readonly systemSettings: SystemSettingRepository,
  ) {}

  async getSiteDeletionSummary(siteId: number): Promise<SiteDeletionSummary> {
    const site = await this.sites.getById(siteId);

    if (!site) {
      throw new Error(`Site ${siteId} not found`);
    }

    return {
      siteId: site.id,
      siteName: site.name,
      baseUrl: site.baseUrl,
      storageRoot: site.storageRoot,
      projectId: site.projectId,
    };
  }

  async getProjectDeletionSummary(projectId: number): Promise<ProjectDeletionSummary> {
    const project = await this.projects.getById(projectId);

    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    const siteIds = await this.sites.listIdsByProjectId(projectId);
    const sites = await Promise.all(siteIds.map((siteId) => this.getSiteDeletionSummary(siteId)));

    return {
      projectId: project.id,
      projectName: project.name,
      projectSlug: project.slug,
      siteCount: sites.length,
      sites,
    };
  }

  async deleteSite(siteId: number): Promise<void> {
    const site = await this.sites.getById(siteId);

    if (!site) {
      throw new Error(`Site ${siteId} not found`);
    }

    if (await this.runs.hasRunningRun(siteId)) {
      throw new Error('站点有运行中的任务，请先等待完成或取消后再删除。');
    }

    const defaultSiteId = await this.systemSettings.getDefaultSiteId();

    if (defaultSiteId === siteId) {
      await this.systemSettings.setDefaultSiteId(null);
    }

    await this.deletions.deleteSite(siteId);
  }

  async deleteProject(projectId: number): Promise<void> {
    const project = await this.projects.getById(projectId);

    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    const siteIds = await this.sites.listIdsByProjectId(projectId);

    for (const siteId of siteIds) {
      if (await this.runs.hasRunningRun(siteId)) {
        throw new Error(`项目下站点 ${siteId} 有运行中的任务，请先等待完成或取消后再删除。`);
      }
    }

    const defaultSiteId = await this.systemSettings.getDefaultSiteId();

    if (defaultSiteId !== null && siteIds.includes(defaultSiteId)) {
      await this.systemSettings.setDefaultSiteId(null);
    }

    await this.deletions.deleteProject(projectId);
  }
}
