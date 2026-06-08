import type { DbClient } from '../database.js';
import type { Clock } from '../../utils/clock.js';

const DEFAULT_SITE_ID_KEY = 'default_site_id';

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
}
