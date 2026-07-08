import { Global, Module } from '@nestjs/common';
import { S3StorageService } from './s3-storage.service';
import { LocalStorageService } from './local-storage.service';
import { STORAGE, IStorage } from './storage.interface';
import { config } from '@/config';

function storageFactory(): IStorage {
  // If S3 endpoint is configured and not a placeholder, use S3
  if (config.s3.endpoint && !config.s3.endpoint.includes('localhost:9000') && config.s3.accessKey) {
    return new S3StorageService({ proxyFetch: async (url: string | URL | Request, init?: RequestInit) => fetch(url, init) } as any);
  }
  return new LocalStorageService();
}

@Global()
@Module({
  providers: [{ provide: STORAGE, useFactory: storageFactory }],
  exports: [STORAGE],
})
export class StorageModule {}
