import { createReadStream } from 'node:fs';
import { basename } from 'node:path';

import { google } from 'googleapis';

import { graphqlRequest } from '../utils/graphql.js';

export interface VaultProject {
  id: string;
  key: string;
  name: string;
  driveFolderId: string;
}

export interface VaultUploadResult {
  fileId: string;
  fileName: string;
  webViewLink: string | null;
  folderId: string;
}

const PROJECT_BY_KEY_QUERY = `
query ProjectByKey($key: String!) {
  projects(filter: { key: { _eq: $key } }, limit: 2) {
    id
    key
    name
    drive_folder_id
  }
}
`;

const EXPORTABLE_PROJECTS_QUERY = `
query ExportableProjects {
  projects(
    filter: { drive_folder_id: { _nnull: true } }
    sort: ["name"]
    limit: 500
  ) {
    id
    key
    name
    drive_folder_id
  }
}
`;

const VAULT_EXPORT_PATH = ['01_L1_source', '03_independent_site_web_data'];

function mapVaultProjectRows(rows: unknown[]): VaultProject[] {
  return rows.map((row) => {
    const record = row as Record<string, unknown>;
    return {
      id: String(record.id),
      key: String(record.key),
      name: String(record.name ?? record.key),
      driveFolderId: typeof record.drive_folder_id === 'string' ? record.drive_folder_id : '',
    };
  });
}

export async function getVaultProjectsByKey(key: string): Promise<VaultProject[]> {
  const trimmedKey = key.trim();
  if (!trimmedKey) {
    throw new Error('目标 project key 不能为空。');
  }

  const result = await graphqlRequest(PROJECT_BY_KEY_QUERY, { key: trimmedKey }, undefined, undefined, false, 3);
  const rows = Array.isArray(result?.data?.projects) ? result.data.projects : [];

  return mapVaultProjectRows(rows);
}

export async function listExportableVaultProjects(): Promise<VaultProject[]> {
  const result = await graphqlRequest(EXPORTABLE_PROJECTS_QUERY, undefined, undefined, undefined, false, 3);
  const rows = Array.isArray(result?.data?.projects) ? result.data.projects : [];

  return mapVaultProjectRows(rows).filter((project) => project.driveFolderId);
}

export class GoogleDriveVaultUploader {
  private readonly serviceAccountFile: string;

  constructor(serviceAccountFile = process.env.KVAULT_GOOGLE_SERVICE_ACCOUNT_FILE ?? process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    if (!serviceAccountFile) {
      throw new Error('请通过 KVAULT_GOOGLE_SERVICE_ACCOUNT_FILE 或 GOOGLE_APPLICATION_CREDENTIALS 指定 Google service account 文件。');
    }
    this.serviceAccountFile = serviceAccountFile;
  }

  async uploadZip(input: {
    sourcePath: string;
    fileName?: string;
    rootFolderId: string;
  }): Promise<VaultUploadResult> {
    if (!input.rootFolderId.trim()) {
      throw new Error('目标 project 缺少 drive_folder_id。');
    }

    const drive = google.drive({
      version: 'v3',
      auth: new google.auth.GoogleAuth({
        keyFile: this.serviceAccountFile,
        scopes: ['https://www.googleapis.com/auth/drive'],
      }),
    });
    const folderId = await this.ensureFolderPath(drive, input.rootFolderId, VAULT_EXPORT_PATH);
    const fileName = input.fileName ?? basename(input.sourcePath);
    const response = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [folderId],
      },
      media: {
        mimeType: 'application/zip',
        body: createReadStream(input.sourcePath),
      },
      fields: 'id, name, webViewLink',
      supportsAllDrives: true,
    });

    const fileId = response.data.id;
    if (!fileId) {
      throw new Error('Google Drive 上传成功但没有返回 file id。');
    }

    return {
      fileId,
      fileName: response.data.name ?? fileName,
      webViewLink: response.data.webViewLink ?? null,
      folderId,
    };
  }

  private async ensureFolderPath(
    drive: ReturnType<typeof google.drive>,
    rootFolderId: string,
    segments: string[],
  ): Promise<string> {
    let parentId = rootFolderId;

    for (const segment of segments) {
      parentId = await this.ensureChildFolder(drive, parentId, segment);
    }

    return parentId;
  }

  private async ensureChildFolder(
    drive: ReturnType<typeof google.drive>,
    parentId: string,
    name: string,
  ): Promise<string> {
    const escapedName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const list = await drive.files.list({
      q: [
        `'${parentId}' in parents`,
        `name = '${escapedName}'`,
        "mimeType = 'application/vnd.google-apps.folder'",
        'trashed = false',
      ].join(' and '),
      fields: 'files(id, name)',
      pageSize: 1,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const existingId = list.data.files?.[0]?.id;
    if (existingId) {
      return existingId;
    }

    const created = await drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      },
      fields: 'id',
      supportsAllDrives: true,
    });
    const createdId = created.data.id;
    if (!createdId) {
      throw new Error(`无法创建 Google Drive 目录: ${name}`);
    }
    return createdId;
  }
}
