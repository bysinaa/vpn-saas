import { Global, Module } from '@nestjs/common';
import { S3StorageService } from './s3-storage.service';
import { LocalStorageService } from './local-storage.service';
import { STORAGE, IStorage } from './storage.interface';
import { config } from '@/config';
import { ProxyHttpService } from '@/common/proxy/proxy-http.service';

async function storageFactory(proxy: ProxyHttpService): Promise<IStorage> {
  if (config.s3.endpoint && config.s3.accessKey) {
    await proxy.ensureAgent();
    return new S3StorageService(proxy);
  }
  return new LocalStorageService();
}

@Global()
@Module({
  providers: [{ provide: STORAGE, inject: [ProxyHttpService], useFactory: storageFactory }],
  exports: [STORAGE],
})
export class StorageModule {}
