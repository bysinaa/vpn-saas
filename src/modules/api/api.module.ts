import { Module } from '@nestjs/common';
import { ApiKeyService } from './api.service';
import { ApiController } from './api.controller';
import { ApiKeyGuard } from './api-key.guard';

@Module({
  controllers: [ApiController],
  providers: [ApiKeyService, ApiKeyGuard],
  exports: [ApiKeyService, ApiKeyGuard],
})
export class ApiModule {}
