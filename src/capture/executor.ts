import type { CaptureCapability } from '../domain/types.js';
import { toolCoversAnyNeed } from './capability-utils.js';
import { CaptureProfileResolver } from './profile-resolver.js';
import { ResultValidator } from './result-validator.js';
import type { CaptureInput, CaptureResult, CaptureTool, CaptureToolResult } from './types.js';
import { CaptureToolRegistry } from './tool-registry.js';

function toolResultHasCapability(toolResult: CaptureToolResult, need: CaptureCapability): boolean {
  switch (need) {
    case 'base':
      return toolResult.extracted !== undefined;
    case 'markdown':
      return toolResult.markdown !== undefined && toolResult.markdown.trim() !== '';
    case 'screenshot':
      return toolResult.screenshot !== undefined && toolResult.screenshot.byteLength > 0;
    case 'structured':
      return toolResult.structured !== undefined;
    default: {
      const exhaustive: never = need;
      return exhaustive;
    }
  }
}

function mergeResult(
  current: CaptureResult,
  toolResult: CaptureToolResult,
  acceptedCapabilities: CaptureCapability[],
): void {
  current.finalUrl = toolResult.finalUrl ?? current.finalUrl;
  current.statusCode = toolResult.statusCode ?? current.statusCode;
  if (acceptedCapabilities.includes('base')) {
    current.html = toolResult.html ?? current.html;
    current.extracted = toolResult.extracted ?? current.extracted;
  }
  if (acceptedCapabilities.includes('structured')) {
    current.structured = toolResult.structured ?? current.structured;
  }

  if (acceptedCapabilities.includes('markdown') && toolResult.markdown !== undefined && toolResult.markdown.trim() !== '') {
    current.markdown = {
      content: toolResult.markdown,
      strategyName: toolResult.markdownStrategyName ?? toolResult.toolName,
    };
  }

  if (acceptedCapabilities.includes('screenshot') && toolResult.screenshot && toolResult.screenshot.byteLength > 0) {
    current.screenshot = {
      data: toolResult.screenshot,
      extension: toolResult.screenshotExtension ?? 'png',
      toolName: toolResult.toolName,
    };
  }
}

function isNeedSatisfied(result: CaptureResult, need: CaptureCapability): boolean {
  switch (need) {
    case 'base':
      return result.extracted !== undefined;
    case 'markdown':
      return result.markdown !== undefined;
    case 'screenshot':
      return result.screenshot !== undefined;
    case 'structured':
      return result.structured !== undefined;
    default: {
      const exhaustive: never = need;
      return exhaustive;
    }
  }
}

export interface PageCaptureExecutorOptions {
  profileResolver?: CaptureProfileResolver;
  validator?: ResultValidator;
}

export class PageCaptureExecutor {
  private readonly profileResolver: CaptureProfileResolver;
  private readonly validator: ResultValidator;

  constructor(
    toolsOrRegistry: CaptureTool[] | CaptureToolRegistry,
    options: PageCaptureExecutorOptions = {},
  ) {
    const defaultToolChain = Array.isArray(toolsOrRegistry)
      ? toolsOrRegistry.map((tool) => tool.name)
      : undefined;
    const registry = Array.isArray(toolsOrRegistry)
      ? new CaptureToolRegistry(toolsOrRegistry)
      : toolsOrRegistry;
    this.profileResolver = options.profileResolver ?? new CaptureProfileResolver(registry, defaultToolChain);
    this.validator = options.validator ?? new ResultValidator();
  }

  async capture(input: CaptureInput): Promise<CaptureResult> {
    const result: CaptureResult = {
      url: input.url,
      diagnostics: [],
    };
    const resolvedProfile = this.profileResolver.resolve({
      siteConfig: input.siteConfig,
      needs: input.needs,
    });

    for (const tool of resolvedProfile.tools) {
      const remainingNeeds = input.needs.filter((need) => !isNeedSatisfied(result, need));

      if (remainingNeeds.length === 0) {
        break;
      }

      if (!toolCoversAnyNeed(tool, remainingNeeds)) {
        result.diagnostics.push({
          toolName: tool.name,
          status: 'skipped',
          capabilities: [...tool.capabilities],
          message: 'tool does not cover any remaining need',
        });
        continue;
      }

      try {
        const toolNeeds = remainingNeeds.filter((need) => tool.capabilities.includes(need));
        const toolResult = await tool.capture({
          ...input,
          needs: toolNeeds,
        });

        const validationMessages: string[] = [];
        const acceptedCapabilities = toolNeeds.filter((need) => {
          if (!toolResultHasCapability(toolResult, need)) {
            validationMessages.push(`${need}: missing`);
            return false;
          }

          const validation = this.validator.validate({
            capability: need,
            result: toolResult,
            siteConfig: input.siteConfig,
            profileValidation: resolvedProfile.profile.validation,
          });
          if (!validation.accepted) {
            validationMessages.push(`${need}: ${validation.message ?? 'rejected'}`);
          }
          return validation.accepted;
        });

        mergeResult(result, toolResult, acceptedCapabilities);
        result.diagnostics.push({
          toolName: tool.name,
          status: acceptedCapabilities.length > 0 ? 'succeeded' : 'failed',
          capabilities: [...tool.capabilities],
          message: validationMessages.length > 0
            ? `profile=${resolvedProfile.name}; ${validationMessages.join(' | ')}`
            : `profile=${resolvedProfile.name}`,
        });
      } catch (error) {
        result.diagnostics.push({
          toolName: tool.name,
          status: 'failed',
          capabilities: [...tool.capabilities],
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const missing = input.needs.filter((need) => !isNeedSatisfied(result, need));
    if (missing.length > 0) {
      const messages = result.diagnostics
        .filter((diagnostic) => diagnostic.status === 'failed' || diagnostic.status === 'skipped')
        .map((diagnostic) => `${diagnostic.toolName}: ${diagnostic.message}`)
        .join(' | ');
      const profileMessage = result.diagnostics.length === 0
        ? `profile resolver returned no tools for needs ${input.needs.join(', ')}`
        : '';
      throw new Error(
        `Capture failed for ${input.url}; missing ${missing.join(', ')}${messages || profileMessage ? `. ${messages || profileMessage}` : ''}`,
      );
    }

    return result;
  }
}
