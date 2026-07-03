import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const frontendDir = join(__dirname, '../frontend/dist');
const textAssetCache = new Map<string, Promise<string>>();
const binaryAssetCache = new Map<string, Promise<Buffer>>();

export function readFrontendAsset(name: string): Promise<string> {
  const cached = textAssetCache.get(name);
  if (cached) {
    return cached;
  }

  const pending = readFile(join(frontendDir, name), 'utf8');
  textAssetCache.set(name, pending);
  return pending;
}

export function readFrontendBinaryAsset(name: string): Promise<Buffer> {
  const cached = binaryAssetCache.get(name);
  if (cached) {
    return cached;
  }

  const pending = readFile(join(frontendDir, 'assets', name));
  binaryAssetCache.set(name, pending);
  return pending;
}
