import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { IStorage, UploadedFile } from './storage.interface';

/**
 * Local filesystem storage — used as a fallback when S3/MinIO is unavailable.
 * Files are saved to a configurable directory under the project root.
 */
@Injectable()
export class LocalStorageService implements IStorage {
  private readonly logger = new Logger(LocalStorageService.name);
  private readonly uploadDir: string;
  private readonly publicBaseUrl: string;

  constructor() {
    this.uploadDir = path.resolve(process.cwd(), 'uploads');
    this.publicBaseUrl = '/uploads';
    // Ensure the upload directory exists on instantiation
    fs.mkdir(this.uploadDir, { recursive: true }).catch((err) => {
      this.logger.error(`Failed to create upload directory ${this.uploadDir}: ${err.message}`);
    });
  }

  async upload(params: {
    key: string;
    body: Buffer;
    mimeType: string;
    isPublic?: boolean;
  }): Promise<UploadedFile> {
    const { key, body, mimeType } = params;
    // Sanitize the key to be a safe file path
    const safeKey = key.replace(/[^a-zA-Z0-9/_\-\.]/g, '_');
    const filePath = path.join(this.uploadDir, safeKey);
    const dir = path.dirname(filePath);

    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, body);
      this.logger.log(`Local file saved: ${filePath}`);
    } catch (err: any) {
      this.logger.error(`Local file save failed: ${err.message}`);
      throw new Error(`Local storage upload failed: ${err.message}`);
    }

    return {
      key: safeKey,
      url: `${this.publicBaseUrl}/${safeKey}`,
      bucket: 'local',
      mimeType,
      size: body.length,
    };
  }

  async delete(key: string): Promise<void> {
    const safeKey = key.replace(/[^a-zA-Z0-9/_\-\.]/g, '_');
    const filePath = path.join(this.uploadDir, safeKey);
    try {
      await fs.unlink(filePath);
    } catch {
      // Ignore if file doesn't exist
    }
  }

  async getSignedUrl(key: string, ttlSeconds = 3600): Promise<string> {
    const safeKey = key.replace(/[^a-zA-Z0-9/_\-\.]/g, '_');
    return `${this.publicBaseUrl}/${safeKey}`;
  }

  getPublicUrl(key: string): string {
    const safeKey = key.replace(/[^a-zA-Z0-9/_\-\.]/g, '_');
    return `${this.publicBaseUrl}/${safeKey}`;
  }
}