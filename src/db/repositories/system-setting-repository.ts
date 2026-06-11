import type { DbClient } from '../database.js';
import type { Clock } from '../../utils/clock.js';
import type { SystemConfig, UrlNormalizationConfig } from '../../domain/types.js';

const DEFAULT_SITE_ID_KEY = 'default_site_id';
const URL_NORMALIZATION_KEY = 'url_normalization';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

function parseUrlNormalization(value: unknown): UrlNormalizationConfig {
  if (!isRecord(value)) {
    return {
      stripQueryParams: [],
      stripQueryParamPrefixes: [],
    };
  }

  return {
    stripQueryParams: parseStringArray(value.stripQueryParams),
    stripQueryParamPrefixes: parseStringArray(value.stripQueryParamPrefixes),
  };
}

export class SystemSettingRepository {
  constructor(
    private readonly db: DbClient,
    private readonly clock: Clock,
  ) {}

  async getDefaultSiteId(): Promise<number | null> {
    const row = await this.db.get<{ value: string }>(
      'SELECT value FROM system_settings WHERE key = ?',
      [DEFAULT_SITE_ID_KEY],
    );

    if (!row) {
      return null;
    }

    const siteId = Number(row.value);
    return Number.isInteger(siteId) && siteId > 0 ? siteId : null;
  }

  async setDefaultSiteId(siteId: number | null): Promise<void> {
    if (siteId === null) {
      await this.db.run('DELETE FROM system_settings WHERE key = ?', [DEFAULT_SITE_ID_KEY]);
      return;
    }

    await this.db.run(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [DEFAULT_SITE_ID_KEY, String(siteId), this.clock.now()],
    );
  }

  async getSystemConfig(): Promise<SystemConfig> {
    const row = await this.db.get<{ value: string }>(
      'SELECT value FROM system_settings WHERE key = ?',
      [URL_NORMALIZATION_KEY],
    );

    return {
      urlNormalization: parseUrlNormalization(row ? JSON.parse(row.value) as unknown : {}),
    };
  }

  async setUrlNormalization(config: UrlNormalizationConfig): Promise<void> {
    await this.db.run(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [
        URL_NORMALIZATION_KEY,
        JSON.stringify({
          stripQueryParams: config.stripQueryParams,
          stripQueryParamPrefixes: config.stripQueryParamPrefixes ?? [],
        }),
        this.clock.now(),
      ],
    );
  }
}
