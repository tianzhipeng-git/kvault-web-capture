import type { CaptureCapability, CaptureProfileConfig, SiteConfig } from '../domain/types.js';
import { toolCoversAnyNeed } from './capability-utils.js';
import type { CaptureTool } from './types.js';
import { CaptureToolRegistry } from './tool-registry.js';

export const DEFAULT_CAPTURE_TOOL_CHAIN = [
  'http-base',
  'defuddle-markdown',
  'lightpanda-markdown',
  'jina-markdown',
  'playwright-screenshot',
] as const;

export interface ResolvedCaptureProfile {
  source: 'site' | 'default';
  profile: CaptureProfileConfig;
  tools: CaptureTool[];
}

export class CaptureProfileResolver {
  constructor(
    private readonly registry: CaptureToolRegistry,
    private readonly defaultToolChain: readonly string[] = DEFAULT_CAPTURE_TOOL_CHAIN,
  ) {}

  resolve(input: {
    siteConfig: SiteConfig;
    needs: CaptureCapability[];
  }): ResolvedCaptureProfile {
    const configuredProfile = input.siteConfig.captureProfile;
    const profile: CaptureProfileConfig = configuredProfile ?? {
      tools: [...this.defaultToolChain],
    };

    const tools = this.registry
      .resolve(profile.tools)
      .filter((tool) => toolCoversAnyNeed(tool, input.needs));

    return {
      source: configuredProfile ? 'site' : 'default',
      profile,
      tools,
    };
  }
}
