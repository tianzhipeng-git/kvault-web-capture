import type { CaptureTool } from '../capture/types.js';
import { DEFAULT_CAPTURE_TOOL_CHAIN } from '../capture/profile-resolver.js';
import type {
  ArtifactType,
  CaptureCapability,
  HistoricalPageState,
  RunType,
  SiteConfig,
  UpdatePolicy,
} from '../domain/types.js';
import { evaluateUrlRules } from '../rules/rule-decision.js';
import { shouldEnqueueArtifactByUpdatePolicy } from './update-policy.js';

function uniqueSorted<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function resolveProspectiveArtifacts(input: {
  url: string;
  siteConfig: SiteConfig;
}): ArtifactType[] {
  const artifacts = new Set<ArtifactType>();

  const urlRules = input.siteConfig.rulesBeforeStage2Eq.filter((rule) => rule.matchType === 'url');
  for (const artifact of evaluateUrlRules(input.url, urlRules).requiredArtifacts) {
    artifacts.add(artifact);
  }

  for (const rule of input.siteConfig.rulesBeforeStage2Eq) {
    if (rule.matchType === 'label' && rule.listType === 'whitelist') {
      for (const artifact of rule.artifacts) {
        artifacts.add(artifact);
      }
    }
  }

  return [...artifacts];
}

function resolveProfileTools(siteConfig: SiteConfig, captureTools: CaptureTool[]): CaptureTool[] {
  const toolNames = siteConfig.captureProfile?.tools ?? [...DEFAULT_CAPTURE_TOOL_CHAIN];

  return toolNames
    .map((name) => captureTools.find((tool) => tool.name === name))
    .filter((tool): tool is CaptureTool => tool !== undefined);
}

export function filterIntegratedEagerArtifacts(input: {
  prospectiveArtifacts: ArtifactType[];
  siteConfig: SiteConfig;
  captureTools: CaptureTool[];
}): ArtifactType[] {
  const integratedTools = resolveProfileTools(input.siteConfig, input.captureTools).filter(
    (tool) => tool.capabilities.includes('base')
      && tool.capabilities.some((capability) => capability !== 'base'),
  );

  if (integratedTools.length === 0) {
    return [];
  }

  return input.prospectiveArtifacts.filter((artifact) =>
    integratedTools.some((tool) => tool.capabilities.includes(artifact)),
  );
}

export function resolveBaseTaskNeeds(input: {
  url: string;
  siteConfig: SiteConfig;
  runType: RunType;
  updatePolicy: UpdatePolicy;
  history: HistoricalPageState | null;
  staleAfterMs: number | null;
  nowIsoString: string;
  captureTools: CaptureTool[];
}): CaptureCapability[] {
  if (input.runType === 'seed_run') {
    return ['base'];
  }

  const needs = new Set<CaptureCapability>(['base']);
  const eagerArtifacts = filterIntegratedEagerArtifacts({
    prospectiveArtifacts: resolveProspectiveArtifacts(input),
    siteConfig: input.siteConfig,
    captureTools: input.captureTools,
  });

  for (const artifactType of eagerArtifacts) {
    if (shouldEnqueueArtifactByUpdatePolicy({
      policy: input.updatePolicy,
      history: input.history,
      artifactType,
      nowIsoString: input.nowIsoString,
      staleAfterMs: input.staleAfterMs,
    })) {
      needs.add(artifactType);
    }
  }

  return uniqueSorted([...needs]);
}
