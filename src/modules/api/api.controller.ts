import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UsePipes,
} from '@nestjs/common';
import { ApiKeyService } from './api.service';
import {
  CreateApiKeyInput,
  UpdateApiKeyInput,
  createApiKeySchema,
  updateApiKeySchema,
} from './api.schemas';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';

/**
 * ApiController - manages API keys for programmatic access.
 * Users can manage their own keys; admins can view all keys.
 */
@Controller('api-keys')
export class ApiController {
  constructor(private readonly apiKeys: ApiKeyService) {}

  @Post()
  @UsePipes(new ZodValidationPipe(createApiKeySchema))
  create(
    @Body() body: CreateApiKeyInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.apiKeys.create(user, {
      name: body.name,
      scopes: body.scopes,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
    });
  }

  @Get('mine')
  listMine(@CurrentUser() user: AuthenticatedUser) {
    return this.apiKeys.listMine(user.id);
  }

  @Patch(':publicId')
  @UsePipes(new ZodValidationPipe(updateApiKeySchema))
  update(
    @Param('publicId') publicId: string,
    @Body() body: UpdateApiKeyInput,
  ) {
    return this.apiKeys.update(publicId, {
      name: body.name,
      scopes: body.scopes,
      isActive: body.isActive,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    });
  }

  @Post(':publicId/revoke')
  revoke(@Param('publicId') publicId: string) {
    return this.apiKeys.revoke(publicId);
  }

  @Delete(':publicId')
  delete(@Param('publicId') publicId: string) {
    return this.apiKeys.delete(publicId);
  }

  // ---- Admin ----
  @Get('admin/all')
  @RequirePermissions(['read:api-keys'])
  listAll() {
    return this.apiKeys.listAll();
  }
}
