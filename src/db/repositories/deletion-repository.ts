import type { DbClient } from '../database.js';

export class DeletionRepository {
  constructor(private readonly db: DbClient) {}

  async deleteSite(siteId: number): Promise<void> {
    await this.db.run(
      'DELETE FROM artifact_runs WHERE site_page_id IN (SELECT id FROM site_pages WHERE site_id = ?)',
      [siteId],
    );
    await this.db.run(
      'DELETE FROM page_runs WHERE site_page_id IN (SELECT id FROM site_pages WHERE site_id = ?)',
      [siteId],
    );
    await this.db.run(
      'DELETE FROM run_logs WHERE crawl_run_id IN (SELECT id FROM crawl_runs WHERE site_id = ?)',
      [siteId],
    );
    await this.db.run(
      `UPDATE site_pages
       SET last_base_run_id = NULL,
           last_markdown_run_id = NULL,
           last_screenshot_run_id = NULL,
           last_structured_run_id = NULL
       WHERE site_id = ?`,
      [siteId],
    );
    await this.db.run('DELETE FROM crawl_runs WHERE site_id = ?', [siteId]);
    await this.db.run('DELETE FROM site_pages WHERE site_id = ?', [siteId]);
    await this.db.run('DELETE FROM sites WHERE id = ?', [siteId]);
  }

  async deleteProject(projectId: number): Promise<void> {
    const sites = await this.db.all<{ id: number }>(
      'SELECT id FROM sites WHERE project_id = ?',
      [projectId],
    );

    for (const site of sites) {
      await this.deleteSite(site.id);
    }

    await this.db.run('DELETE FROM projects WHERE id = ?', [projectId]);
  }
}
