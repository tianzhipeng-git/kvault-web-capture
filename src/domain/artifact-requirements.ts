import { createHash } from 'node:crypto';

import type {
  ArtifactRequirement,
  ArtifactType,
  ScreenshotConfig,
  ScreenshotPreparationConfig,
  ScreenshotVariantConfig,
  SiteConfig,
} from './types.js';

export const SCREENSHOT_PROTOCOL_VERSION = 1 as const;

export const DEFAULT_SCREENSHOT_PREPARATION: ScreenshotPreparationConfig = {
  waitForImages: true,
  waitForFonts: true,
  scrollDocument: true,
  scrollContainers: true,
  expandScrollContainers: true,
  scrollStepRatio: 0.8,
  settleMs: 500,
  stableRounds: 2,
  maxScrollRounds: 100,
  maxCaptureHeight: 50_000,
  timeoutMs: 90_000,
  onLimit: 'truncate',
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function screenshotFingerprint(
  screenshot: ScreenshotConfig,
  variant: ScreenshotVariantConfig,
): string {
  const payload = canonicalize({
    mode: screenshot.mode,
    preparation: screenshot.preparation ?? DEFAULT_SCREENSHOT_PREPARATION,
    protocolVersion: SCREENSHOT_PROTOCOL_VERSION,
    variant,
  });
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function defaultArtifactRequirement(artifactType: ArtifactType): ArtifactRequirement {
  return {
    artifactType,
    variantKey: 'default',
    configFingerprint: null,
  };
}

export function expandArtifactRequirements(
  artifactTypes: ArtifactType[],
  siteConfig: SiteConfig,
): ArtifactRequirement[] {
  return artifactTypes.flatMap((artifactType) => {
    if (artifactType !== 'screenshot' || siteConfig.screenshot?.mode !== 'complete') {
      return [defaultArtifactRequirement(artifactType)];
    }

    return (siteConfig.screenshot.variants ?? []).map((variant) => ({
      artifactType,
      variantKey: variant.key,
      configFingerprint: screenshotFingerprint(siteConfig.screenshot!, variant),
    }));
  });
}

export function requirementKey(requirement: ArtifactRequirement): string {
  return [
    requirement.artifactType,
    requirement.variantKey,
    requirement.configFingerprint ?? '',
  ].join(':');
}

export function parseArtifactRequirementsJson(value: string | null): ArtifactRequirement[] {
  if (!value) {
    return [];
  }
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((item): ArtifactRequirement[] => {
    if (typeof item === 'string') {
      return [defaultArtifactRequirement(item as ArtifactType)];
    }
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as ArtifactRequirement).artifactType === 'string'
    ) {
      const requirement = item as ArtifactRequirement;
      return [{
        artifactType: requirement.artifactType,
        variantKey: requirement.variantKey || 'default',
        configFingerprint: requirement.configFingerprint ?? null,
      }];
    }
    return [];
  });
}
