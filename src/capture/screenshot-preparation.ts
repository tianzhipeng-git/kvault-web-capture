import { readFile } from 'node:fs/promises';

import type { Page } from 'playwright';
import type { ScreenshotPreparationConfig } from '../domain/types.js';

interface PreparationResult {
  documentScrollCompleted: boolean;
  scrollContainersFound: number;
  scrollContainersCompleted: number;
  scrollContainersExpanded: number;
  imagesFound: number;
  imagesPending: number;
  fontsReady: boolean;
  truncated: boolean;
  limitReason: string | null;
  preparationDurationMs: number;
  documentWidth: number;
  documentHeight: number;
  warnings: string[];
}

let scriptPromise: Promise<string> | null = null;

async function script(): Promise<string> {
  scriptPromise ??= readFile(new URL('./screenshot-preparation.browser.js', import.meta.url), 'utf8');
  return scriptPromise;
}

async function invoke<T>(
  page: Pick<Page, 'evaluate'>,
  payload: Record<string, unknown>,
): Promise<T> {
  const source = await script();
  return page.evaluate(`(${source}\n)(${JSON.stringify(payload)})`) as Promise<T>;
}

export async function prepareScreenshot(
  page: Pick<Page, 'evaluate'>,
  config: ScreenshotPreparationConfig,
): Promise<PreparationResult> {
  return invoke(page, { action: 'prepare', config });
}

export async function cleanupScreenshotPreparation(
  page: Pick<Page, 'evaluate'>,
): Promise<void> {
  await invoke(page, { action: 'cleanup' });
}
