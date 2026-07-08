import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UsePipes,
} from '@nestjs/common';
import { SettingsService } from './settings.service';
import {
  UpsertSettingInput,
  UpdateFeatureFlagInput,
  upsertSettingSchema,
  updateFeatureFlagSchema,
} from './settings.schemas';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { Public } from '../auth/decorators/public.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';

/**
 * SettingsController - manages system configuration and feature flags.
 * Public settings endpoint is accessible without auth.
 */
@Controller()
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  // ---- Public settings (no auth) ----
  @Public()
  @Get('settings/public')
  listPublic() {
    return this.settings.listPublic();
  }

  // ---- Admin: system settings ----
  @Get('admin/settings')
  @RequirePermissions(['read:settings'])
  listAll(@Query('category') category?: string) {
    return this.settings.listAll(category);
  }

  @Get('admin/settings/:key')
  @RequirePermissions(['read:settings'])
  get(@Param('key') key: string) {
    return this.settings.get(key);
  }

  @Post('admin/settings')
  @RequirePermissions(['manage:settings'])
  @UsePipes(new ZodValidationPipe(upsertSettingSchema))
  upsert(@Body() body: UpsertSettingInput) {
    return this.settings.upsert(body);
  }

  @Delete('admin/settings/:key')
  @RequirePermissions(['manage:settings'])
  remove(@Param('key') key: string) {
    return this.settings.remove(key);
  }

  // ---- Admin: feature flags ----
  @Get('admin/flags')
  @RequirePermissions(['read:settings'])
  listFlags() {
    return this.settings.listFlags();
  }

  @Patch('admin/flags/:key')
  @RequirePermissions(['manage:settings'])
  @UsePipes(new ZodValidationPipe(updateFeatureFlagSchema))
  updateFlag(
    @Param('key') key: string,
    @Body() body: UpdateFeatureFlagInput,
  ) {
    return this.settings.upsertFlag(key, body);
  }

  @Delete('admin/flags/:key')
  @RequirePermissions(['manage:settings'])
  removeFlag(@Param('key') key: string) {
    return this.settings.removeFlag(key);
  }
}
