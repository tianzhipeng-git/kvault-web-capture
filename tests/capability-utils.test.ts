import { describe, expect, it } from 'vitest';

import { toolCoversAnyNeed } from '../src/capture/capability-utils.js';
import type { CaptureCapability } from '../src/domain/types.js';
import type { CaptureTool, CaptureInput, CaptureToolResult } from '../src/capture/types.js';

describe('toolCoversAnyNeed', () => {
  const createMockTool = (capabilities: CaptureCapability[]): CaptureTool => {
    return {
      name: 'mock-tool',
      capabilities,
      capture: async (input: CaptureInput): Promise<CaptureToolResult> => {
        return { toolName: 'mock-tool' };
      },
    };
  };

  it('returns true when tool capabilities exactly match needs', () => {
    const tool = createMockTool(['base', 'markdown']);
    expect(toolCoversAnyNeed(tool, ['base', 'markdown'])).toBe(true);
  });

  it('returns true when tool capabilities partially match needs', () => {
    const tool = createMockTool(['base']);
    expect(toolCoversAnyNeed(tool, ['base', 'markdown'])).toBe(true);
  });

  it('returns true when tool has more capabilities than needed', () => {
    const tool = createMockTool(['base', 'markdown', 'screenshot']);
    expect(toolCoversAnyNeed(tool, ['base'])).toBe(true);
  });

  it('returns false when tool capabilities do not match any needs', () => {
    const tool = createMockTool(['screenshot']);
    expect(toolCoversAnyNeed(tool, ['base', 'markdown'])).toBe(false);
  });

  it('returns false when tool has empty capabilities', () => {
    const tool = createMockTool([]);
    expect(toolCoversAnyNeed(tool, ['base'])).toBe(false);
  });

  it('returns true when needs array is empty', () => {
    const tool = createMockTool(['base']);
    expect(toolCoversAnyNeed(tool, [])).toBe(true);
  });

  it('returns true when both tool capabilities and needs are empty', () => {
    const tool = createMockTool([]);
    expect(toolCoversAnyNeed(tool, [])).toBe(true);
  });
});
