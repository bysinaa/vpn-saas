import { Buffer } from 'node:buffer';

/**
 * Storage abstraction. New backends (S3, local, GCS, Azure) implement this
 * so business code depends only on the interface (Open/Closed Principle).
 */
export interface UploadedFile {
  key: string;
  url: string;
  bucket: string;
  mimeType: string;
  size: number;
  etag?: string;
}

export interface IStorage {
  upload(params: {
    key: string;
    body: Buffer;
    mimeType: string;
    isPublic?: boolean;
  }): Promise<UploadedFile>;

  delete(key: string): Promise<void>;

  getSignedUrl(key: string, ttlSeconds?: number): Promise<string>;
  getPublicUrl(key: string): string;
}

/** NestJS DI token for the storage interface. */
export const STORAGE = Symbol('STORAGE');
