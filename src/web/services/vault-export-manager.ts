import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';

import type { ProjectExportResult, SitePageIdExportResult } from '../../export/project-exporter.js';
import {
  getVaultProjectsByKey,
  GoogleDriveVaultUploader,
  listExportableVaultProjects,
  type VaultProject,
  type VaultUploadResult,
} from '../../export/vault-drive.js';

export type VaultExportPhase = 'queued' | 'exporting_zip' | 'uploading_drive' | 'succeeded' | 'failed';

export interface VaultExportTaskSnapshot {
  taskId: string;
  phase: VaultExportPhase;
  message: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  targetProject: VaultProject;
  fileName: string | null;
  exportResult: ProjectExportResult | (SitePageIdExportResult & { runId?: number }) | null;
  uploadResult: VaultUploadResult | null;
  errorMessage: string | null;
}

type ZipExportResult = ProjectExportResult | (SitePageIdExportResult & { runId?: number });

const runningPhases = new Set<VaultExportPhase>(['queued', 'exporting_zip', 'uploading_drive']);
const DEFAULT_UPLOAD_TIMEOUT_MS = 1000 * 60 * 15;

function parsePositiveMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isRunningPhase(phase: VaultExportPhase): boolean {
  return runningPhases.has(phase);
}

export class VaultExportManager {
  private task: VaultExportTaskSnapshot | null = null;
  private readonly tasks: VaultExportTaskSnapshot[] = [];
  private readonly uploadTimeoutMs: number;

  constructor(
    private readonly deps: {
      findTargetProjects?: (key: string) => Promise<VaultProject[]>;
      listTargetProjects?: () => Promise<VaultProject[]>;
      uploadZip?: (input: {
        sourcePath: string;
        fileName?: string;
        rootFolderId: string;
      }) => Promise<VaultUploadResult>;
      uploadTimeoutMs?: number;
    } = {},
  ) {
    this.uploadTimeoutMs = deps.uploadTimeoutMs ?? parsePositiveMs(
      process.env.KVAULT_VAULT_EXPORT_UPLOAD_TIMEOUT_MS,
      DEFAULT_UPLOAD_TIMEOUT_MS,
    );
  }

  getSnapshot(): VaultExportTaskSnapshot | null {
    this.failExpiredRunningTask();
    return this.task;
  }

  listSnapshots(): VaultExportTaskSnapshot[] {
    this.failExpiredRunningTask();
    return [...this.tasks];
  }

  async listTargetProjects(): Promise<VaultProject[]> {
    return this.deps.listTargetProjects
      ? this.deps.listTargetProjects()
      : listExportableVaultProjects();
  }

  async findTargetProjects(key: string): Promise<VaultProject[]> {
    return this.fetchTargetProjects(key);
  }

  start(input: {
    targetProjectKey: string;
    exportZip: () => Promise<ZipExportResult>;
  }): VaultExportTaskSnapshot {
    this.failExpiredRunningTask();

    if (this.task && isRunningPhase(this.task.phase)) {
      throw new Error('已有导出到 Vault Drive 的任务正在运行。');
    }

    const taskId = randomUUID();
    const now = new Date().toISOString();
    const pendingTask: VaultExportTaskSnapshot = {
      taskId,
      phase: 'queued',
      message: '任务已创建，等待后台开始。',
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      targetProject: {
        id: '',
        key: input.targetProjectKey.trim(),
        name: input.targetProjectKey.trim(),
        driveFolderId: '',
      },
      fileName: null,
      exportResult: null,
      uploadResult: null,
      errorMessage: null,
    };
    this.task = pendingTask;
    this.tasks.unshift(pendingTask);
    this.tasks.splice(20);

    void this.runTask(taskId, input).catch(() => {
      // runTask records failures in the task snapshot.
    });

    return pendingTask;
  }

  private async runTask(
    taskId: string,
    input: {
      targetProjectKey: string;
      exportZip: () => Promise<ZipExportResult>;
    },
  ): Promise<void> {
    let outputPath: string | null = null;
    let terminalUpdate: Partial<VaultExportTaskSnapshot> | null = null;

    try {
      const targetProject = await this.resolveTargetProject(input.targetProjectKey);
      this.update(taskId, {
        targetProject,
        phase: 'exporting_zip',
        message: '正在生成 ZIP 文件。',
      });

      const exportResult = await input.exportZip();
      outputPath = exportResult.outputPath;
      this.update(taskId, {
        exportResult,
        fileName: exportResult.fileName,
        phase: 'uploading_drive',
        message: '正在上传到 Google Drive。',
      });

      const uploadResult = await this.withUploadTimeout(
        this.uploadZip({
          sourcePath: exportResult.outputPath,
          fileName: exportResult.fileName,
          rootFolderId: targetProject.driveFolderId,
        }),
      );
      terminalUpdate = {
        uploadResult,
        phase: 'succeeded',
        message: '已上传到 Vault Drive。',
        finishedAt: new Date().toISOString(),
      };
    } catch (error) {
      terminalUpdate = {
        phase: 'failed',
        message: '导出到 Vault Drive 失败。',
        errorMessage: error instanceof Error ? error.message : '未知错误',
        finishedAt: new Date().toISOString(),
      };
    } finally {
      if (outputPath) {
        await rm(outputPath, { force: true });
      }
    }

    if (terminalUpdate) {
      this.update(taskId, terminalUpdate);
    }
  }

  private async resolveTargetProject(key: string): Promise<VaultProject> {
    const projects = await this.fetchTargetProjects(key);
    if (projects.length === 0) {
      throw new Error(`未找到 Directus project: ${key}`);
    }
    if (projects.length > 1) {
      throw new Error(`Directus project key 不唯一: ${key}`);
    }
    const project = projects[0];
    if (!project.driveFolderId) {
      throw new Error(`Directus project ${project.key} 缺少 drive_folder_id。`);
    }
    return project;
  }

  private fetchTargetProjects(key: string): Promise<VaultProject[]> {
    return this.deps.findTargetProjects
      ? this.deps.findTargetProjects(key)
      : getVaultProjectsByKey(key);
  }

  private uploadZip(input: {
    sourcePath: string;
    fileName?: string;
    rootFolderId: string;
  }): Promise<VaultUploadResult> {
    return this.deps.uploadZip
      ? this.deps.uploadZip(input)
      : new GoogleDriveVaultUploader().uploadZip(input);
  }

  private update(taskId: string, patch: Partial<VaultExportTaskSnapshot>): void {
    if (!this.task || this.task.taskId !== taskId) {
      return;
    }

    this.task = {
      ...this.task,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    const index = this.tasks.findIndex((task) => task.taskId === taskId);
    if (index >= 0) {
      this.tasks[index] = this.task;
    }
  }

  private async withUploadTimeout(upload: Promise<VaultUploadResult>): Promise<VaultUploadResult> {
    let timeout: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        upload,
        new Promise<VaultUploadResult>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error('Google Drive 上传等待超时；如果文件已出现在 Vault，请以 Vault 文件为准。'));
          }, this.uploadTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private failExpiredRunningTask(): void {
    if (!this.task || !isRunningPhase(this.task.phase)) {
      return;
    }

    // uploading_drive 由 runTask 内的 withUploadTimeout 处理，避免重复超时与清理竞态。
    if (this.task.phase === 'uploading_drive') {
      return;
    }

    const updatedAt = Date.parse(this.task.updatedAt);
    if (!Number.isFinite(updatedAt) || Date.now() - updatedAt <= this.uploadTimeoutMs) {
      return;
    }

    this.update(this.task.taskId, {
      phase: 'failed',
      message: '导出任务已超时。',
      errorMessage: '导出任务长时间未更新，已自动释放任务锁；如果文件已出现在 Vault，请以 Vault 文件为准。',
      finishedAt: new Date().toISOString(),
    });
  }
}
