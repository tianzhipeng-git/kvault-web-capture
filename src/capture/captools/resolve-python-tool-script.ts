import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolvePythonToolScript(fileName: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'pytools', fileName),
    join(process.cwd(), 'dist', 'src', 'capture', 'pytools', fileName),
    join(process.cwd(), 'src', 'capture', 'pytools', fileName),
    join(here, '..', '..', '..', 'src', 'capture', 'pytools', fileName),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`Python capture tool script not found: ${fileName}`);
  }
  return found;
}
