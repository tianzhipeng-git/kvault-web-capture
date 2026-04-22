import { M1App } from '../app/services.js';
import type { SpikeRunOptions, SpikeRunSummary } from '../domain/types.js';

export async function runIntegrationSpike(
  options: SpikeRunOptions,
): Promise<SpikeRunSummary> {
  const app = new M1App({
    dbPath: options.dbPath,
  });

  try {
    const project = app.createProject('spike-project');
    const site = app.createSite({
      projectSlug: project.slug,
      name: options.siteName ?? 'spike-site',
      baseUrl: new URL(options.seedUrl).origin,
      storageRoot: options.storageDir,
    });

    return app.runCrawl({
      siteId: site.id,
      updatePolicy: 'force_recrawl_all',
      targetSuccessCount: null,
      staleAfterMs: null,
    });
  } finally {
    app.close();
  }
}
