import { Logger } from '@nestjs/common';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  type BucketLocationConstraint,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl as presign } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { config } from '@/config';
import { ProxyHttpService } from '@/common/proxy/proxy-http.service';
import { IStorage, UploadedFile } from './storage.interface';

type S3Sender = Pick<S3Client, 'send'>;

export class S3StorageService implements IStorage {
  private readonly logger = new Logger(S3StorageService.name);
  private readonly bucket = config.s3.bucket;
  private readonly client: S3Sender;
  private readonly signingClient: S3Client;
  private bucketReady?: Promise<void>;

  constructor(proxy?: ProxyHttpService, client?: S3Sender) {
    if (client) {
      this.client = client;
      this.signingClient = client as S3Client;
      return;
    }

    const sdkClient = new S3Client(this.clientConfig(proxy));
    this.client = sdkClient;
    this.signingClient = this.isLocalEndpoint()
      ? new S3Client({ ...this.clientConfig(), endpoint: this.publicEndpoint() })
      : sdkClient;
  }

  private clientConfig(proxy?: ProxyHttpService): S3ClientConfig {
    const agent = this.isLocalEndpoint() ? undefined : proxy?.getAgent(config.s3.endpoint);
    return {
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      forcePathStyle: config.s3.forcePathStyle,
      credentials: {
        accessKeyId: config.s3.accessKey,
        secretAccessKey: config.s3.secretKey,
      },
      requestHandler: agent
        ? new NodeHttpHandler({ httpAgent: agent, httpsAgent: agent })
        : new NodeHttpHandler(),
    };
  }

  private isLocalEndpoint(): boolean {
    const host = new URL(config.s3.endpoint).hostname.toLowerCase();
    return (
      host === 'minio' ||
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
  }

  private publicEndpoint(): string {
    const url = new URL(config.s3.publicUrl);
    const path = url.pathname.replace(/\/$/, '');
    if (config.s3.forcePathStyle && path.endsWith(`/${this.bucket}`)) {
      url.pathname = path.slice(0, -this.bucket.length - 1) || '/';
    }
    return url.toString().replace(/\/$/, '');
  }

  private async ensureBucket(): Promise<void> {
    if (!this.bucketReady) {
      this.bucketReady = this.bootstrapBucket().catch((error) => {
        this.bucketReady = undefined;
        throw error;
      });
    }
    return this.bucketReady;
  }

  private async bootstrapBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return;
    } catch (error) {
      if (!this.isMissingBucket(error)) throw error;
    }

    try {
      await this.client.send(
        new CreateBucketCommand({
          Bucket: this.bucket,
          ...(config.s3.region === 'us-east-1'
            ? {}
            : {
                CreateBucketConfiguration: {
                  LocationConstraint: config.s3.region as BucketLocationConstraint,
                },
              }),
        }),
      );
    } catch (error) {
      if (!this.isBucketAlreadyOwned(error)) throw error;
    }
  }

  private isMissingBucket(error: unknown): boolean {
    const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    return (
      value?.$metadata?.httpStatusCode === 404 ||
      ['NotFound', 'NoSuchBucket'].includes(value?.name ?? '')
    );
  }

  private isBucketAlreadyOwned(error: unknown): boolean {
    const name = (error as { name?: string })?.name;
    return name === 'BucketAlreadyOwnedByYou';
  }

  getPublicUrl(key: string): string {
    return `${config.s3.publicUrl.replace(/\/$/, '')}/${this.encodeKey(key)}`;
  }

  async upload(params: {
    key: string;
    body: Buffer;
    mimeType: string;
    isPublic?: boolean;
  }): Promise<UploadedFile> {
    const { key, body, mimeType, isPublic = false } = params;
    await this.ensureBucket();

    try {
      const result = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: mimeType,
          ...(isPublic ? { ACL: 'public-read' as const } : {}),
        }),
      );
      return {
        key,
        url: isPublic ? this.getPublicUrl(key) : await this.getSignedUrl(key),
        bucket: this.bucket,
        mimeType,
        size: body.length,
        etag: result.ETag,
      };
    } catch (error) {
      const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      this.logger.error(
        `S3 upload failed (${value?.$metadata?.httpStatusCode ?? 'unknown'}): ${value?.name ?? 'S3Error'}`,
      );
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async getSignedUrl(key: string, ttlSeconds = 3600): Promise<string> {
    return presign(
      this.signingClient,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }

  private encodeKey(key: string): string {
    return key.split('/').map(encodeURIComponent).join('/');
  }
}

/** Generate a safe object key with date-partitioned path + uuid. */
export function buildStorageKey(prefix: string, ext: string, mime: string): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const uuid = randomUUID();
  return `${prefix}/${y}/${m}/${d}/${uuid}.${ext}`;
}

export function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
    'image/gif': 'gif',
  };
  return map[mime] ?? 'bin';
}
