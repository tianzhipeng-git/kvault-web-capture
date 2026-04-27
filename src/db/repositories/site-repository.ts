import type { DatabaseSync } from 'node:sqlite';
import type { SiteConfig } from '../../domain/types.js';
import type { Clock } from '../../utils/clock.js';
import { type RowIdResult, parseJson, toId } from './helpers.js';

export interface SiteRecord {
  id: number;
  projectId: number;
  name: string;
  baseUrl: string;
  storageRoot: string;
  config: SiteConfig;
}

export class SiteRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  create(input: {
    projectId: number;
    name: string;
    baseUrl: string;
    storageRoot: string;
    config: SiteConfig;
  }): SiteRecord {
    const now = this.clock.now();
    const result = this.db
      .prepare(
        `INSERT INTO sites (
          project_id,
          name,
          base_url,
          storage_root,
          config_json,
          updated_at,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        input.name,
        input.baseUrl,
        input.storageRoot,
        JSON.stringify(input.config),
        now,
        now,
      ) as RowIdResult;

    return {
      id: toId(result),
      projectId: input.projectId,
      name: input.name,
      baseUrl: input.baseUrl,
      storageRoot: input.storageRoot,
      config: input.config,
    };
  }

  getById(siteId: number): SiteRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, name, base_url, storage_root, config_json
         FROM sites
         WHERE id = ?`,
      )
      .get(siteId) as
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

  updateConfig(siteId: number, config: SiteConfig): void {
    this.db
      .prepare('UPDATE sites SET config_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(config), this.clock.now(), siteId);
  }

  cloneConfig(sourceSiteId: number, targetSiteId: number): void {
    const source = this.getById(sourceSiteId);

    if (!source) {
      throw new Error(`Site ${sourceSiteId} not found`);
    }

    this.updateConfig(targetSiteId, { ...source.config, seedUrls: [], sitemaps: [] });
  }
}

