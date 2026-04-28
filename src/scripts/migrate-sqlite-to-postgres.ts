import 'dotenv/config';

import { resolve } from 'node:path';

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
  const sqliteDb = await openDatabase({ dialect: 'sqlite', path: sqlitePath });
  const postgresDb = await openDatabase({ dialect: 'postgres', url: postgresUrl });

  try {
    const rows = await sqliteDb.all<DbRow>(`SELECT * FROM ${table} ORDER BY id`);
    if (rows.length === 0) {
      return 0;
    }

    const firstRow = rows[0];
    const columns = Object.keys(firstRow);
    const quotedColumns = columns.map(quoteIdentifier).join(', ');
    const placeholders = columns.map(() => '?').join(', ');
    const insertSql = `INSERT INTO ${table} (${quotedColumns}) VALUES (${placeholders})`;

    for (const row of rows) {
      const params = columns.map((column) => {
        const value = row[column];
        if (value === undefined) {
          return null;
        }
        return value as string | number | bigint | Buffer | null;
      });
      await postgresDb.run(insertSql, params);
    }

    return rows.length;
  } finally {
    await sqliteDb.close();
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

  const counts: Array<{ table: TableName; count: number }> = [];
  for (const table of TABLES_IN_ORDER) {
    const count = await copyTable(sqlitePath, postgresUrl, table);
    counts.push({ table, count });
    console.log(`[migrate] ${table}: ${count}`);
  }

  await resetPostgresSequences(postgresUrl);

  const total = counts.reduce((sum, item) => sum + item.count, 0);
  console.log(`[migrate] done. sqlite=${sqlitePath}, total_rows=${total}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
