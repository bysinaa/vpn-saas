jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://minio.test/signed-receipt'),
}));
jest.mock('@/config', () => ({
  config: {
    s3: {
      endpoint: 'http://minio:9000',
      region: 'us-east-1',
      bucket: 'receipts-test',
      accessKey: 'test-access',
      secretKey: 'test-secret',
      forcePathStyle: true,
      publicUrl: 'http://minio:9000/receipts-test',
    },
  },
}));

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl as presign } from '@aws-sdk/s3-request-presigner';
import { S3StorageService } from './s3-storage.service';

function clientWith(send: jest.Mock) {
  return { send } as any;
}

describe('S3StorageService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('bypasses the outbound proxy for the local MinIO endpoint', () => {
    const proxy = { getAgent: jest.fn() };

    new S3StorageService(proxy as any);

    expect(proxy.getAgent).not.toHaveBeenCalled();
  });

  it('uploads a private MinIO-compatible object with authenticated SDK commands', async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ ETag: '"etag-1"' });
    const storage = new S3StorageService(undefined, clientWith(send));

    const result = await storage.upload({
      key: 'receipts/user/receipt.jpg',
      body: Buffer.from('receipt'),
      mimeType: 'image/jpeg',
    });

    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadBucketCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(PutObjectCommand);
    expect(send.mock.calls[1][0].input).toEqual(
      expect.objectContaining({
        Bucket: expect.any(String),
        Key: 'receipts/user/receipt.jpg',
        ContentType: 'image/jpeg',
      }),
    );
    expect(send.mock.calls[1][0].input).not.toHaveProperty('ACL');
    expect(result).toEqual(
      expect.objectContaining({
        key: 'receipts/user/receipt.jpg',
        url: 'https://minio.test/signed-receipt',
        etag: '"etag-1"',
      }),
    );
  });

  it('does not create a bucket or upload when credentials are rejected', async () => {
    const denied = Object.assign(new Error('denied'), {
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    });
    const send = jest.fn().mockRejectedValue(denied);
    const storage = new S3StorageService(undefined, clientWith(send));

    await expect(
      storage.upload({ key: 'receipt.jpg', body: Buffer.from('x'), mimeType: 'image/jpeg' }),
    ).rejects.toBe(denied);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadBucketCommand);
  });

  it('creates a missing bucket once and reuses the successful bootstrap', async () => {
    const missing = Object.assign(new Error('missing'), {
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    });
    const send = jest
      .fn()
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ ETag: 'one' })
      .mockResolvedValueOnce({ ETag: 'two' });
    const storage = new S3StorageService(undefined, clientWith(send));

    await storage.upload({ key: 'one.jpg', body: Buffer.from('1'), mimeType: 'image/jpeg' });
    await storage.upload({ key: 'two.jpg', body: Buffer.from('2'), mimeType: 'image/jpeg' });

    expect(send.mock.calls.filter(([command]) => command instanceof HeadBucketCommand)).toHaveLength(1);
    expect(send.mock.calls.filter(([command]) => command instanceof CreateBucketCommand)).toHaveLength(1);
    expect(send.mock.calls.filter(([command]) => command instanceof PutObjectCommand)).toHaveLength(2);
  });

  it('deletes the requested private object', async () => {
    const send = jest.fn().mockResolvedValue({});
    const storage = new S3StorageService(undefined, clientWith(send));

    await storage.delete('receipts/user/receipt.jpg');

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBeInstanceOf(DeleteObjectCommand);
    expect(send.mock.calls[0][0].input.Key).toBe('receipts/user/receipt.jpg');
  });

  it('returns a time-limited signed URL for private retrieval', async () => {
    const client = clientWith(jest.fn());
    const storage = new S3StorageService(undefined, client);

    await expect(storage.getSignedUrl('receipts/private.jpg', 120)).resolves.toBe(
      'https://minio.test/signed-receipt',
    );
    expect(presign).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ input: expect.objectContaining({ Key: 'receipts/private.jpg' }) }),
      { expiresIn: 120 },
    );
  });
});
