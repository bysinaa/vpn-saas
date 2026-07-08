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
import { EducationService } from './education.service';
import {
  CreateArticleInput,
  createArticleSchema,
  UpdateArticleInput,
  updateArticleSchema,
} from './education.schemas';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';

@Controller('education')
export class EducationController {
  constructor(private readonly education: EducationService) {}

  @Get()
  list(@Query('topic') topic?: string) {
    return this.education.listPublished(topic);
  }

  @Get(':slug')
  getBySlug(@Param('slug') slug: string) {
    return this.education.getBySlug(slug);
  }

  @Post(':slug/read')
  markRead(
    @Param('slug') slug: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.education.trackProgress(user.id, BigInt(slug));
  }

  @Post(':slug/helpful')
  markHelpful(@Param('slug') slug: string) {
    return this.education.markHelpful(BigInt(slug));
  }

  @Get('progress/me')
  getProgress(@CurrentUser() user: AuthenticatedUser) {
    return this.education.getProgress(user.id);
  }

  // ---- Admin ----
  @Get('admin/all')
  @RequirePermissions(['read:education'])
  listAll(@Query() query: Record<string, unknown>) {
    return this.education.listAll(query);
  }

  @Post('admin')
  @RequirePermissions(['manage:education'])
  @UsePipes(new ZodValidationPipe(createArticleSchema))
  create(@Body() body: CreateArticleInput) {
    return this.education.create(body);
  }

  @Patch('admin/:id')
  @RequirePermissions(['manage:education'])
  @UsePipes(new ZodValidationPipe(updateArticleSchema))
  update(@Param('id') id: string, @Body() body: UpdateArticleInput) {
    return this.education.update(BigInt(id), body as Record<string, unknown>);
  }

  @Delete('admin/:id')
  @RequirePermissions(['manage:education'])
  delete(@Param('id') id: string) {
    return this.education.delete(BigInt(id));
  }
}
