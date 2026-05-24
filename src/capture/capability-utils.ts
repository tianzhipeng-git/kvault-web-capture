import type { CaptureCapability } from '../domain/types.js';
import type { CaptureTool } from './types.js';

export function toolCoversAnyNeed(tool: CaptureTool, needs: CaptureCapability[]): boolean {
  return needs.some((need) => tool.capabilities.includes(need));
}
