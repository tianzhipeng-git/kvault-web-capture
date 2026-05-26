import type { CaptureCapability, CaptureProfileConfig, SiteConfig } from '../domain/types.js';
import { toolCoversAnyNeed } from './capability-utils.js';
import type { CaptureTool } from './types.js';
import { CaptureToolRegistry } from './tool-registry.js';

export const DEFAULT_CAPTURE_PROFILE_NAME = 'default';

export const DEFAULT_CAPTURE_TOOL_CHAIN = [
  'http-base',
  'defuddle-markdown',
  'lightpanda-markdown',
  'jina-markdown',
  'playwright-screenshot',
] as const;

export interface ResolvedCaptureProfile {
  name: string;
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
    const profileName = input.siteConfig.defaultCaptureProfile ?? DEFAULT_CAPTURE_PROFILE_NAME;
    const configuredProfile = input.siteConfig.captureProfiles?.[profileName];
    const profile: CaptureProfileConfig = configuredProfile ?? {
      tools: [...this.defaultToolChain],
    };

    const tools = this.registry
      .resolve(profile.tools)
      .filter((tool) => toolCoversAnyNeed(tool, input.needs));

    return {
      name: configuredProfile ? profileName : DEFAULT_CAPTURE_PROFILE_NAME,
      profile,
      tools,
    };
  }
}
