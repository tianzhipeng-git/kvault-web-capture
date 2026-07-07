import { createDefaultSiteConfig, loadSiteConfig, parseSiteConfig } from '../config/site-config.js';
import type {
  PageRunRepository,
  ProjectRepository,
  SitePageRepository,
  SiteRepository,
  SystemSettingRepository,
} from '../db/repositories/index.js';
import type { SiteConfig, UrlNormalizationConfig } from '../domain/types.js';
import { buildPathTree } from '../utils/path-tree.js';

const FAVICON_SIZE = 64;
const FAVICON_API_URL = 'https://www.google.com/s2/favicons';
const MAX_FAVICON_BYTES = 256 * 1024;

export class SiteService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly sites: SiteRepository,
    private readonly sitePages: SitePageRepository,
    private readonly pageRuns: PageRunRepository,
    private readonly systemSettings: SystemSettingRepository,
  ) {}

  async createSite(input: {
    projectId?: number;
    projectSlug?: string;
    name: string;
    baseUrl: string;
    storageRoot: string;
  }): Promise<{ id: number; name: string }> {
    const project = input.projectId != null
      ? await this.projects.getById(input.projectId)
      : input.projectSlug != null
        ? await this.projects.getBySlug(input.projectSlug)
        : null;

    if (!project) {
      throw new Error('Project not found');
    }

    const site = await this.sites.create({
      projectId: project.id,
      name: input.name,
      baseUrl: input.baseUrl,
      storageRoot: input.storageRoot,
      config: createDefaultSiteConfig(input.baseUrl),
    });

    return {
      id: site.id,
      name: site.name,
    };
  }

  async importConfig(siteId: number, configPath: string): Promise<void> {
    await this.getSite(siteId);
    await this.sites.updateConfig(siteId, loadSiteConfig(configPath));
  }

  async cloneConfig(sourceSiteId: number, targetSiteId: number): Promise<void> {
    await this.sites.cloneConfig(sourceSiteId, targetSiteId);
  }

  async getConfig(siteId: number): Promise<SiteConfig> {
    return (await this.getSite(siteId)).config;
  }

  async updateConfig(siteId: number, config: SiteConfig): Promise<void> {
    await this.getSite(siteId);
    await this.sites.updateConfig(siteId, parseSiteConfig(config));
  }

  async fetchFavicon(siteId: number): Promise<{ status: string; byteLength: number; contentType: string }> {
    const site = await this.getSite(siteId);
    const domain = new URL(site.baseUrl).hostname;
    const url = `${FAVICON_API_URL}?domain=${encodeURIComponent(domain)}&sz=${FAVICON_SIZE}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Favicon fetch failed: ${response.status}`);
    }

    const data = Buffer.from(await response.arrayBuffer());

    if (data.length === 0) {
      throw new Error('Favicon fetch returned empty response');
    }

    if (data.length > MAX_FAVICON_BYTES) {
      throw new Error(`Favicon is too large: ${data.length} bytes`);
    }

    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'image/x-icon';
    await this.sites.updateFavicon(siteId, { data, contentType });

    return {
      status: 'ok',
      byteLength: data.length,
      contentType,
    };
  }

  async getFavicon(siteId: number) {
    await this.getSite(siteId);
    return this.sites.getFavicon(siteId);
  }

  async getDefaultSite(): Promise<{
    siteId: number;
    siteName: string;
    projectId: number;
    baseUrl: string;
  } | null> {
    return this.getSiteSetting(
      () => this.systemSettings.getDefaultSiteId(),
      () => this.systemSettings.setDefaultSiteId(null),
    );
  }

  async getDefaultMarkdownSite(): Promise<{
    siteId: number;
    siteName: string;
    projectId: number;
    baseUrl: string;
  } | null> {
    return this.getSiteSetting(
      () => this.systemSettings.getDefaultMarkdownSiteId(),
      () => this.systemSettings.setDefaultMarkdownSiteId(null),
    );
  }

  async setDefaultSite(siteId: number | null): Promise<void> {
    if (siteId !== null) {
      await this.getSite(siteId);
    }

    await this.systemSettings.setDefaultSiteId(siteId);
  }

  async setDefaultMarkdownSite(siteId: number | null): Promise<void> {
    if (siteId !== null) {
      await this.getSite(siteId);
    }

    await this.systemSettings.setDefaultMarkdownSiteId(siteId);
  }

  private async getSiteSetting(
    getSiteId: () => Promise<number | null>,
    clearSiteId: () => Promise<void>,
  ): Promise<{
    siteId: number;
    siteName: string;
    projectId: number;
    baseUrl: string;
  } | null> {
    const siteId = await getSiteId();

    if (siteId === null) {
      return null;
    }

    const site = await this.sites.getById(siteId);

    if (!site) {
      await clearSiteId();
      return null;
    }

    return {
      siteId: site.id,
      siteName: site.name,
      projectId: site.projectId,
      baseUrl: site.baseUrl,
    };
  }

  getSystemConfig() {
    return this.systemSettings.getSystemConfig();
  }

  async updateSystemUrlNormalization(config: UrlNormalizationConfig) {
    await this.systemSettings.setUrlNormalization(config);
    return this.systemSettings.getSystemConfig();
  }

  getInventorySummary(siteId: number) {
    return this.sitePages.summarizeInventory(siteId);
  }

  listPendingPages(siteId: number) {
    return this.sitePages.listByInventoryStatus(siteId, 'stage2_pending');
  }

  listDeniedPages(siteId: number) {
    return this.sitePages.listByInventoryStatus(siteId, 'url_rule_denied');
  }

  async getPathTree(siteId: number) {
    await this.getSite(siteId);
    const urls = (await this.sitePages.listKnownUrls(siteId)).map((row) => row.normalizedUrl);
    return buildPathTree(urls);
  }

  listSampleCaptures(siteId: number, limit: number) {
    return this.pageRuns.listSampleCaptures(siteId, limit);
  }

  private async getSite(siteId: number) {
    const site = await this.sites.getById(siteId);

    if (!site) {
      throw new Error(`Site ${siteId} not found`);
    }

    return site;
  }
}
