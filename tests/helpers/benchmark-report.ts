import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const BENCHMARK_URLS = [
  'https://bot.sannysoft.com/',
  'https://antispider4.scrape.center/',
] as const;

export const BENCHMARK_REPORT_DIR = join(
  process.cwd(),
  '.tmp',
  'e2e-capture-reports',
);

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

export function writeBenchmarkReport(fileLabel: string, report: unknown): string {
  mkdirSync(BENCHMARK_REPORT_DIR, { recursive: true });
  const outputPath = join(BENCHMARK_REPORT_DIR, `${sanitizeFileName(fileLabel)}.json`);
  writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
  return outputPath;
}
