import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ArtifactType } from '../domain/types.js';

export interface ArtifactWriteResult {
  outputPath: string;
  content: string | null;
}

export class FileArtifactWriter {
  constructor(private readonly siteStorageRoot: string) {}

  writeBaseCapture(input: {
    runId: number;
    sitePageId: number;
    content: string;
  }): ArtifactWriteResult {
    const outputPath = join(
      this.siteStorageRoot,
      'artifacts',
      `run-${input.runId}`,
      `page-${input.sitePageId}`,
      'base.md',
    );
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, input.content, 'utf8');
    return {
      outputPath,
      content: input.content,
    };
  }

  writeTextArtifact(input: {
    artifactType: ArtifactType;
    runId: number;
    sitePageId: number;
    content: string;
    extension: string;
  }): ArtifactWriteResult {
    const outputPath = this.buildPath(
      input.runId,
      input.sitePageId,
      input.artifactType,
      input.extension,
    );
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, input.content, 'utf8');
    return {
      outputPath,
      content: input.content,
    };
  }

  writeBinaryArtifact(input: {
    artifactType: ArtifactType;
    runId: number;
    sitePageId: number;
    content: Buffer;
    extension: string;
  }): ArtifactWriteResult {
    const outputPath = this.buildPath(
      input.runId,
      input.sitePageId,
      input.artifactType,
      input.extension,
    );
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, input.content);
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
