import 'dotenv/config';

import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../db/database.js';

const TABLES_IN_ORDER = [
  'projects',
  'sites',
  'crawl_runs',
  'site_pages',
  'page_runs',
  'artifact_runs',
  'run_logs',
] as const;

type TableName = (typeof TABLES_IN_ORDER)[number];
type DbRow = Record<string, unknown>;
type SqliteColumnInfo = { name: string };

const SITE_PAGE_RUN_REFERENCE_COLUMNS = [
  'last_base_run_id',
  'last_markdown_run_id',
  'last_screenshot_run_id',
] as const;

type SitePageRunReferenceColumn = (typeof SITE_PAGE_RUN_REFERENCE_COLUMNS)[number];

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

function getRequiredArg(flag: string, fallback?: string): string {
  const value = getArg(flag) ?? fallback;
  if (!value) {
    throw new Error(`Missing required flag ${flag}`);
  }
  return value;
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function openSqliteDatabase(sqlitePath: string): DatabaseSync {
  const sqliteDb = new DatabaseSync(sqlitePath);
  sqliteDb.exec('PRAGMA foreign_keys = ON');
  return sqliteDb;
}

function getSqliteTableColumns(sqliteDb: DatabaseSync, table: TableName): string[] {
  return sqliteDb
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all()
    .map((row) => String((row as SqliteColumnInfo).name));
}

function getValidRowSelectSql(table: TableName): string {
  switch (table) {
    case 'projects':
      return 'SELECT * FROM projects ORDER BY id';
    case 'sites':
      return `SELECT s.*
              FROM sites s
              INNER JOIN projects p ON p.id = s.project_id
              ORDER BY s.id`;
    case 'crawl_runs':
      return `SELECT cr.*
              FROM crawl_runs cr
              INNER JOIN sites s ON s.id = cr.site_id
              INNER JOIN projects p ON p.id = s.project_id
              ORDER BY cr.id`;
    case 'site_pages':
      return `SELECT sp.*
              FROM site_pages sp
              INNER JOIN sites s ON s.id = sp.site_id
              INNER JOIN projects p ON p.id = s.project_id
              ORDER BY sp.id`;
    case 'page_runs':
      return `SELECT pr.*
              FROM page_runs pr
              INNER JOIN crawl_runs cr ON cr.id = pr.crawl_run_id
              INNER JOIN sites cr_site ON cr_site.id = cr.site_id
              INNER JOIN projects cr_project ON cr_project.id = cr_site.project_id
              INNER JOIN site_pages sp ON sp.id = pr.site_page_id
              INNER JOIN sites sp_site ON sp_site.id = sp.site_id
              INNER JOIN projects sp_project ON sp_project.id = sp_site.project_id
              ORDER BY pr.id`;
    case 'artifact_runs':
      return `SELECT ar.*
              FROM artifact_runs ar
              INNER JOIN crawl_runs cr ON cr.id = ar.crawl_run_id
              INNER JOIN sites cr_site ON cr_site.id = cr.site_id
              INNER JOIN projects cr_project ON cr_project.id = cr_site.project_id
              INNER JOIN site_pages sp ON sp.id = ar.site_page_id
              INNER JOIN sites sp_site ON sp_site.id = sp.site_id
              INNER JOIN projects sp_project ON sp_project.id = sp_site.project_id
              INNER JOIN page_runs pr ON pr.id = ar.page_run_id
              INNER JOIN crawl_runs pr_cr ON pr_cr.id = pr.crawl_run_id
              INNER JOIN sites pr_cr_site ON pr_cr_site.id = pr_cr.site_id
              INNER JOIN projects pr_cr_project ON pr_cr_project.id = pr_cr_site.project_id
              INNER JOIN site_pages pr_sp ON pr_sp.id = pr.site_page_id
              INNER JOIN sites pr_sp_site ON pr_sp_site.id = pr_sp.site_id
              INNER JOIN projects pr_sp_project ON pr_sp_project.id = pr_sp_site.project_id
              ORDER BY ar.id`;
    case 'run_logs':
      return `SELECT rl.*
              FROM run_logs rl
              INNER JOIN crawl_runs cr ON cr.id = rl.crawl_run_id
              INNER JOIN sites s ON s.id = cr.site_id
              INNER JOIN projects p ON p.id = s.project_id
              ORDER BY rl.id`;
  }
}

function countSqliteRows(sqliteDb: DatabaseSync, table: TableName): number {
  const row = sqliteDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return Number(row.count);
}

function warnSkippedRows(table: TableName, totalCount: number, copiedCount: number): void {
  const skippedCount = totalCount - copiedCount;
  if (skippedCount <= 0) {
    return;
  }

  console.warn(
    `[migrate] warning: skipped ${skippedCount} ${table} rows with missing required parent records`,
  );
}

function asDbValue(value: unknown): string | number | bigint | Buffer | null {
  if (value === undefined) {
    return null;
  }
  return value as string | number | bigint | Buffer | null;
}

async function assertTargetIsEmpty(postgresUrl: string): Promise<void> {
  const postgresDb = await openDatabase({ dialect: 'postgres', url: postgresUrl });
  try {
    for (const table of TABLES_IN_ORDER) {
      const row = await postgresDb.get<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${table}`);
      if ((row?.count ?? 0) > 0) {
        throw new Error(`Target PostgreSQL is not empty: table "${table}" already has ${row?.count} rows`);
      }
    }
  } finally {
    await postgresDb.close();
  }
}

async function copyTable(sqlitePath: string, postgresUrl: string, table: TableName): Promise<number> {
  const sqliteDb = openSqliteDatabase(sqlitePath);
  const postgresDb = await openDatabase({ dialect: 'postgres', url: postgresUrl });

  try {
    const totalCount = countSqliteRows(sqliteDb, table);
    const columns = getSqliteTableColumns(sqliteDb, table);
    const quotedColumns = columns.map(quoteIdentifier).join(', ');
    const placeholders = columns.map(() => '?').join(', ');
    const insertSql = `INSERT INTO ${table} (${quotedColumns}) VALUES (${placeholders})`;
    const selectStatement = sqliteDb.prepare(getValidRowSelectSql(table));

    let count = 0;
    for (const row of selectStatement.iterate() as Iterable<DbRow>) {
      const params = columns.map((column) => asDbValue(row[column]));
      await postgresDb.run(insertSql, params);
      count += 1;
    }

    warnSkippedRows(table, totalCount, count);
    return count;
  } finally {
    sqliteDb.close();
    await postgresDb.close();
  }
}

async function copySitePagesWithoutRunReferences(
  sqlitePath: string,
  postgresUrl: string,
): Promise<number> {
  const sqliteDb = openSqliteDatabase(sqlitePath);
  const postgresDb = await openDatabase({ dialect: 'postgres', url: postgresUrl });

  try {
    const totalCount = countSqliteRows(sqliteDb, 'site_pages');
    const columns = getSqliteTableColumns(sqliteDb, 'site_pages');
    const quotedColumns = columns.map(quoteIdentifier).join(', ');
    const placeholders = columns.map(() => '?').join(', ');
    const insertSql = `INSERT INTO site_pages (${quotedColumns}) VALUES (${placeholders})`;
    const selectStatement = sqliteDb.prepare(getValidRowSelectSql('site_pages'));

    let count = 0;
    for (const row of selectStatement.iterate() as Iterable<DbRow>) {
      const params = columns.map((column) => {
        if (SITE_PAGE_RUN_REFERENCE_COLUMNS.includes(column as SitePageRunReferenceColumn)) {
          return null;
        }
        return asDbValue(row[column]);
      });
      await postgresDb.run(insertSql, params);
      count += 1;
    }

    warnSkippedRows('site_pages', totalCount, count);
    return count;
  } finally {
    sqliteDb.close();
    await postgresDb.close();
  }
}

async function warnMissingSitePageRunReferences(sqlitePath: string): Promise<void> {
  const sqliteDb = await openDatabase({ dialect: 'sqlite', path: sqlitePath });

  try {
    const missingReferences: string[] = [];
    for (const column of SITE_PAGE_RUN_REFERENCE_COLUMNS) {
      const rows = await sqliteDb.all<{ site_page_id: number; missing_run_id: number }>(
        `SELECT sp.id AS site_page_id, sp.${column} AS missing_run_id
         FROM site_pages sp
         LEFT JOIN crawl_runs cr ON cr.id = sp.${column}
         WHERE sp.${column} IS NOT NULL AND cr.id IS NULL
         ORDER BY sp.id
         LIMIT 10`,
      );

      for (const row of rows) {
        missingReferences.push(
          `site_pages.id=${row.site_page_id} ${column}=${row.missing_run_id}`,
        );
      }
    }

    if (missingReferences.length === 0) {
      return;
    }

    console.warn(
      `[migrate] warning: skipping missing site_pages run references: ${missingReferences.join(', ')}`,
    );
  } finally {
    await sqliteDb.close();
  }
}

async function backfillSitePageRunReferences(sqlitePath: string, postgresUrl: string): Promise<void> {
  const sqliteDb = openSqliteDatabase(sqlitePath);
  const postgresDb = await openDatabase({ dialect: 'postgres', url: postgresUrl });

  try {
    const selectStatement = sqliteDb.prepare(
      `SELECT
         sp.id,
         CASE WHEN base_run.id IS NULL THEN NULL ELSE sp.last_base_run_id END AS last_base_run_id,
         CASE WHEN markdown_run.id IS NULL THEN NULL ELSE sp.last_markdown_run_id END AS last_markdown_run_id,
         CASE WHEN screenshot_run.id IS NULL THEN NULL ELSE sp.last_screenshot_run_id END AS last_screenshot_run_id
       FROM site_pages sp
       LEFT JOIN crawl_runs base_run ON base_run.id = sp.last_base_run_id
       LEFT JOIN crawl_runs markdown_run ON markdown_run.id = sp.last_markdown_run_id
       LEFT JOIN crawl_runs screenshot_run ON screenshot_run.id = sp.last_screenshot_run_id
       ORDER BY sp.id`,
    );

    for (const row of selectStatement.iterate() as Iterable<DbRow>) {
      await postgresDb.run(
        `UPDATE site_pages
         SET last_base_run_id = ?,
             last_markdown_run_id = ?,
             last_screenshot_run_id = ?
         WHERE id = ?`,
        [
          asDbValue(row.last_base_run_id),
          asDbValue(row.last_markdown_run_id),
          asDbValue(row.last_screenshot_run_id),
          asDbValue(row.id),
        ],
      );
    }
  } finally {
    sqliteDb.close();
    await postgresDb.close();
  }
}

async function resetPostgresSequences(postgresUrl: string): Promise<void> {
  const postgresDb = await openDatabase({ dialect: 'postgres', url: postgresUrl });
  try {
    for (const table of TABLES_IN_ORDER) {
      await postgresDb.exec(`
        SELECT setval(
          pg_get_serial_sequence('${table}', 'id'),
          COALESCE((SELECT MAX(id) FROM ${table}), 1),
          (SELECT MAX(id) IS NOT NULL FROM ${table})
        );
      `);
    }
  } finally {
    await postgresDb.close();
  }
}

async function main(): Promise<void> {
  const sqlitePath = resolve(getRequiredArg('--sqlite', process.env.KVAULT_DB_PATH ?? '.local/state.db'));
  const postgresUrl = getRequiredArg('--postgres-url', process.env.KVAULT_DATABASE_URL);

  await assertTargetIsEmpty(postgresUrl);
  await warnMissingSitePageRunReferences(sqlitePath);

  const counts: Array<{ table: TableName; count: number }> = [];
  for (const table of TABLES_IN_ORDER) {
    const count =
      table === 'site_pages'
        ? await copySitePagesWithoutRunReferences(sqlitePath, postgresUrl)
        : await copyTable(sqlitePath, postgresUrl, table);
    counts.push({ table, count });
    console.log(`[migrate] ${table}: ${count}`);
  }

  await backfillSitePageRunReferences(sqlitePath, postgresUrl);
  console.log('[migrate] site_pages run references backfilled');

  await resetPostgresSequences(postgresUrl);

  const total = counts.reduce((sum, item) => sum + item.count, 0);
  console.log(`[migrate] done. sqlite=${sqlitePath}, total_rows=${total}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
