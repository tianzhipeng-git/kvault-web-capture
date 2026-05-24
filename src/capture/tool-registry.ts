import type { CaptureTool } from './types.js';

export class CaptureToolRegistry {
  private readonly tools = new Map<string, CaptureTool>();

  constructor(tools: CaptureTool[] = []) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  register(tool: CaptureTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Capture tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): CaptureTool {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown capture tool: ${name}`);
    }
    return tool;
  }

  resolve(names: string[]): CaptureTool[] {
    return names.map((name) => this.get(name));
  }

  listNames(): string[] {
    return [...this.tools.keys()];
  }
}
