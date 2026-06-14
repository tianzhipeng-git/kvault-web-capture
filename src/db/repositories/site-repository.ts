import type { DbClient } from '../database.js';
import type { SiteConfig } from '../../domain/types.js';
import type { Clock } from '../../utils/clock.js';
import { parseJson } from './helpers.js';

export interface SiteRecord {
  id: number;
  projectId: number;
  name: string;
  baseUrl: string;
  storageRoot: string;
  config: SiteConfig;
}

export interface SiteFaviconRecord {
  data: Buffer;
  contentType: string;
  updatedAt: string;
}

export class SiteRepository {
  constructor(
    private readonly db: DbClient,
    private readonly clock: Clock,
  ) {}

  async create(input: {
    projectId: number;
    name: string;
    baseUrl: string;
    storageRoot: string;
    config: SiteConfig;
  }): Promise<SiteRecord> {
    const now = this.clock.now();
    const result = await this.db.run(
        `INSERT INTO sites (
          project_id,
          name,
          base_url,
          storage_root,
          config_json,
          updated_at,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.projectId,
        input.name,
        input.baseUrl,
        input.storageRoot,
        JSON.stringify(input.config),
        now,
        now,
      ],
    );

    return {
      id: Number(result.lastInsertId),
      projectId: input.projectId,
      name: input.name,
      baseUrl: input.baseUrl,
      storageRoot: input.storageRoot,
      config: input.config,
    };
  }

  async getById(siteId: number): Promise<SiteRecord | null> {
    const row = await this.db.get(
        `SELECT id, project_id, name, base_url, storage_root, config_json
         FROM sites
         WHERE id = ?`,
      [siteId],
    ) as
      | {
          id: number;
          project_id: number;
          name: string;
          base_url: string;
          storage_root: string;
          config_json: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      baseUrl: row.base_url,
      storageRoot: row.storage_root,
      config: parseJson<SiteConfig>(row.config_json),
    };
  }

  async updateFavicon(siteId: number, favicon: { data: Buffer; contentType: string }): Promise<void> {
    const now = this.clock.now();
    await this.db.run(
      `UPDATE sites
       SET favicon_data = ?, favicon_content_type = ?, favicon_updated_at = ?, updated_at = ?
       WHERE id = ?`,
      [favicon.data, favicon.contentType, now, now, siteId],
    );
  }

  async getFavicon(siteId: number): Promise<SiteFaviconRecord | null> {
    const row = await this.db.get<{
      favicon_data: Buffer | null;
      favicon_content_type: string | null;
      favicon_updated_at: string | null;
    }>(
      `SELECT favicon_data, favicon_content_type, favicon_updated_at
       FROM sites
       WHERE id = ?`,
      [siteId],
    );

    if (!row?.favicon_data || !row.favicon_content_type || !row.favicon_updated_at) {
      return null;
    }

    return {
      data: row.favicon_data,
      contentType: row.favicon_content_type,
      updatedAt: row.favicon_updated_at,
    };
  }

  async updateConfig(siteId: number, config: SiteConfig): Promise<void> {
    await this.db.run('UPDATE sites SET config_json = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify(config),
      this.clock.now(),
      siteId,
    ]);
  }

  async listIdsByProjectId(projectId: number): Promise<number[]> {
    const rows = await this.db.all<{ id: number }>(
      'SELECT id FROM sites WHERE project_id = ? ORDER BY id',
      [projectId],
    );

    return rows.map((row) => row.id);
  }

  async cloneConfig(sourceSiteId: number, targetSiteId: number): Promise<void> {
    const source = await this.getById(sourceSiteId);

    if (!source) {
      throw new Error(`Site ${sourceSiteId} not found`);
    }

    await this.updateConfig(targetSiteId, { ...source.config, seedUrls: [], sitemaps: [] });
  }
}
