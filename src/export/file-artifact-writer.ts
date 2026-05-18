import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ArtifactType } from '../domain/types.js';

export interface ArtifactWriteResult {
  outputPath: string;
  content: string | null;
}

export class FileArtifactWriter {
  constructor(private readonly siteStorageRoot: string) {}

  async writeBaseCapture(input: {
    runId: number;
    sitePageId: number;
    content: string;
  }): Promise<ArtifactWriteResult> {
    const outputPath = join(
      this.siteStorageRoot,
      'artifacts',
      `run-${input.runId}`,
      `page-${input.sitePageId}`,
      'base.md',
    );
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, input.content, 'utf8');
    return {
      outputPath,
      content: input.content,
    };
  }

  async writeTextArtifact(input: {
    artifactType: ArtifactType;
    runId: number;
    sitePageId: number;
    content: string;
    extension: string;
  }): Promise<ArtifactWriteResult> {
    const outputPath = this.buildPath(
      input.runId,
      input.sitePageId,
      input.artifactType,
      input.extension,
    );
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, input.content, 'utf8');
    return {
      outputPath,
      content: input.content,
    };
  }

  async writeBinaryArtifact(input: {
    artifactType: ArtifactType;
    runId: number;
    sitePageId: number;
    content: Buffer;
    extension: string;
  }): Promise<ArtifactWriteResult> {
    const outputPath = this.buildPath(
      input.runId,
      input.sitePageId,
      input.artifactType,
      input.extension,
    );
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, input.content);
    return {
      outputPath,
      content: null,
    };
  }

  private buildPath(
    runId: number,
    sitePageId: number,
    artifactType: ArtifactType,
    extension: string,
  ): string {
    return join(
      this.siteStorageRoot,
      'artifacts',
      `run-${runId}`,
      `page-${sitePageId}`,
      `${artifactType}.${extension}`,
    );
  }
}
