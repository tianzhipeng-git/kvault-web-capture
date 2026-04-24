import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

export function loadDefaultEnvFile(cwd: string = process.cwd()): void {
  const envPath = resolve(cwd, '.env');

  if (!existsSync(envPath)) {
    return;
  }

  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
    return;
  }

  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/u);

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();

    if (key === '' || key in process.env) {
      continue;
    }

    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    process.env[key] = stripWrappingQuotes(rawValue);
  }
}
