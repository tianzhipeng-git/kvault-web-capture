import type { CaptureCapability } from '../domain/types.js';
import type { CaptureInput, CaptureResult, CaptureTool } from './types.js';

function coversAnyNeed(tool: CaptureTool, needs: CaptureCapability[]): boolean {
  return needs.some((need) => tool.capabilities.includes(need));
}

function mergeResult(current: CaptureResult, toolResult: Awaited<ReturnType<CaptureTool['capture']>>): void {
  current.finalUrl = toolResult.finalUrl ?? current.finalUrl;
  current.statusCode = toolResult.statusCode ?? current.statusCode;
  current.html = toolResult.html ?? current.html;
  current.extracted = toolResult.extracted ?? current.extracted;
  current.structured = toolResult.structured ?? current.structured;

  if (toolResult.markdown !== undefined && toolResult.markdown.trim() !== '') {
    current.markdown = {
      content: toolResult.markdown,
      strategyName: toolResult.markdownStrategyName ?? toolResult.toolName,
    };
  }

  if (toolResult.screenshot && toolResult.screenshot.byteLength > 0) {
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

export class PageCaptureExecutor {
  constructor(private readonly tools: CaptureTool[]) {}

  async capture(input: CaptureInput): Promise<CaptureResult> {
    const result: CaptureResult = {
      url: input.url,
      diagnostics: [],
    };

    for (const tool of this.tools) {
      const remainingNeeds = input.needs.filter((need) => !isNeedSatisfied(result, need));

      if (remainingNeeds.length === 0) {
        break;
      }

      if (!coversAnyNeed(tool, remainingNeeds)) {
        result.diagnostics.push({
          toolName: tool.name,
          status: 'skipped',
          capabilities: [...tool.capabilities],
          message: 'tool does not cover any remaining need',
        });
        continue;
      }

      try {
        const toolResult = await tool.capture({
          ...input,
          needs: remainingNeeds.filter((need) => tool.capabilities.includes(need)),
        });
        mergeResult(result, toolResult);
        result.diagnostics.push({
          toolName: tool.name,
          status: 'succeeded',
          capabilities: [...tool.capabilities],
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
        .filter((diagnostic) => diagnostic.status === 'failed')
        .map((diagnostic) => `${diagnostic.toolName}: ${diagnostic.message}`)
        .join(' | ');
      throw new Error(
        `Capture failed for ${input.url}; missing ${missing.join(', ')}${messages ? `. ${messages}` : ''}`,
      );
    }

    return result;
  }
}
