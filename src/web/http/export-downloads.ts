import { randomUUID } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';

import type { FastifyReply } from 'fastify';

const EXPORT_DOWNLOAD_TTL_MS = 1000 * 60 * 60;

interface PreparedExport {
  outputPath: string;
  fileName: string;
  expiresAt: number;
}

function exportContentType(fileName: string): string {
  if (fileName.endsWith('.xlsx')) {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }

  return 'application/zip';
}

export class ExportDownloadStore {
  private readonly preparedExports = new Map<string, PreparedExport>();

  async cleanupExpiredPreparedExports(now = Date.now()): Promise<void> {
    const expiredPaths: string[] = [];

    for (const [key, value] of this.preparedExports) {
      if (value.expiresAt <= now) {
        this.preparedExports.delete(key);
        expiredPaths.push(value.outputPath);
      }
    }

    await Promise.all(expiredPaths.map(removeExportFile));
  }

  buildPreparedExportResponse(result: { outputPath: string; fileName: string }) {
    return {
      token: this.rememberPreparedExport(result),
      fileName: result.fileName,
      expiresInSeconds: Math.floor(EXPORT_DOWNLOAD_TTL_MS / 1000),
    };
  }

  async sendPreparedExportDownload(reply: FastifyReply, token: string) {
    const prepared = this.preparedExports.get(token);
    if (!prepared || prepared.expiresAt <= Date.now()) {
      this.preparedExports.delete(token);
      if (prepared) {
        await removeExportFile(prepared.outputPath);
      }
      reply.code(404);
      throw new Error('导出文件已过期，请重新导出。');
    }

    this.preparedExports.delete(token);
    const fileStat = await stat(prepared.outputPath);
    const stream = createReadStream(prepared.outputPath);
    deleteAfterReply(reply, prepared.outputPath, stream);
    return reply
      .type(exportContentType(prepared.fileName))
      .header('Content-Disposition', `attachment; filename="${prepared.fileName}"`)
      .header('Content-Length', fileStat.size)
      .header('Cache-Control', 'no-store')
      .send(stream);
  }

  private rememberPreparedExport(result: { outputPath: string; fileName: string }): string {
    const token = randomUUID();
    const now = Date.now();

    void this.cleanupExpiredPreparedExports(now);

    this.preparedExports.set(token, {
      outputPath: result.outputPath,
      fileName: result.fileName,
      expiresAt: now + EXPORT_DOWNLOAD_TTL_MS,
    });

    return token;
  }
}

export async function sendZipFile(
  reply: FastifyReply,
  result: { outputPath: string; fileName: string },
) {
  const fileStat = await stat(result.outputPath);
  const stream = createReadStream(result.outputPath);
  deleteAfterReply(reply, result.outputPath, stream);
  return reply
    .type('application/zip')
    .header('Content-Disposition', `attachment; filename="${result.fileName}"`)
    .header('Content-Length', fileStat.size)
    .send(stream);
}

async function removeExportFile(outputPath: string): Promise<void> {
  try {
    await rm(outputPath, { force: true });
  } catch {
    // Export cleanup is best-effort; a failed delete must not fail the download response.
  }
}

function deleteAfterReply(reply: FastifyReply, outputPath: string, stream: ReadStream): void {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    void removeExportFile(outputPath);
  };

  reply.raw.once('finish', cleanup);
  reply.raw.once('close', cleanup);
  stream.once('close', cleanup);
  stream.once('error', cleanup);
}
