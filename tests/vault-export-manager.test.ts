import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { VaultExportManager } from '../src/web/services/vault-export-manager.js';

async function waitForFinished(manager: VaultExportManager) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const task = manager.getSnapshot();
    if (task?.phase === 'succeeded' || task?.phase === 'failed') {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Task did not finish');
}

describe('VaultExportManager', () => {
  const targetProject = {
    id: 'directus-project-1',
    key: 'proj',
    name: 'Project',
    driveFolderId: 'root-folder',
  };

  it('runs one background export and removes the local zip', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kvault-vault-export-'));
    const outputPath = join(dir, 'export.zip');
    const uploadZip = vi.fn(async () => ({
      fileId: 'drive-file-1',
      fileName: 'export.zip',
      webViewLink: 'https://drive.example/export.zip',
      folderId: 'leaf-folder',
    }));
    const manager = new VaultExportManager({
      findTargetProjects: async () => [targetProject],
      uploadZip,
    });

    manager.start({
      targetProjectKey: 'proj',
      exportZip: async () => {
        writeFileSync(outputPath, 'zip');
        return {
          outputPath,
          fileName: 'export.zip',
          projectId: 1,
          siteCount: 1,
          pageCount: 2,
          artifactFileCount: 3,
        };
      },
    });
    expect(() => manager.start({
      targetProjectKey: 'proj',
      exportZip: async () => {
        throw new Error('should not run');
      },
    })).toThrow('已有导出到 Vault Drive 的任务正在运行。');

    const task = await waitForFinished(manager);
    expect(task.phase).toBe('succeeded');
    expect(manager.listSnapshots()).toHaveLength(1);
    expect(manager.listSnapshots()[0].taskId).toBe(task.taskId);
    expect(task.uploadResult?.fileId).toBe('drive-file-1');
    expect(uploadZip).toHaveBeenCalledWith({
      sourcePath: outputPath,
      fileName: 'export.zip',
      rootFolderId: 'root-folder',
    });
    expect(existsSync(outputPath)).toBe(false);
  });

  it('times out stuck uploads and releases the export lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kvault-vault-export-timeout-'));
    const outputPath = join(dir, 'stuck.zip');
    const nextOutputPath = join(dir, 'next.zip');
    const uploadZip = vi.fn()
      .mockImplementationOnce(() => new Promise<never>(() => {}))
      .mockImplementationOnce(async () => ({
        fileId: 'drive-file-2',
        fileName: 'next.zip',
        webViewLink: null,
        folderId: 'leaf-folder',
      }));
    const manager = new VaultExportManager({
      findTargetProjects: async () => [targetProject],
      uploadZip,
      uploadTimeoutMs: 20,
    });

    manager.start({
      targetProjectKey: 'proj',
      exportZip: async () => {
        writeFileSync(outputPath, 'zip');
        return {
          outputPath,
          fileName: 'stuck.zip',
          projectId: 1,
          siteCount: 1,
          pageCount: 2,
          artifactFileCount: 3,
        };
      },
    });

    const timedOutTask = await waitForFinished(manager);
    expect(timedOutTask.phase).toBe('failed');
    expect(timedOutTask.errorMessage).toContain('Google Drive 上传等待超时');
    expect(existsSync(outputPath)).toBe(false);

    manager.start({
      targetProjectKey: 'proj',
      exportZip: async () => {
        writeFileSync(nextOutputPath, 'zip');
        return {
          outputPath: nextOutputPath,
          fileName: 'next.zip',
          projectId: 1,
          siteCount: 1,
          pageCount: 2,
          artifactFileCount: 3,
        };
      },
    });

    expect((await waitForFinished(manager)).phase).toBe('succeeded');
  });
});
