import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PlansService } from './plans.service';
import { PlansSchemas } from './plans.schemas';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { Public } from '../auth/decorators/public.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';

@ApiTags('Plans')
@Controller('plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  // ---- Public catalog ----
  @Public()
  @Get()
  @ApiOperation({ summary: 'List visible plans (public catalog)' })
  visible() {
    return this.plans.listVisible();
  }

  @Public()
  @Get('categories')
  @ApiOperation({ summary: 'List plan categories' })
  categories() {
    return this.plans.listCategories();
  }

  @Public()
  @Get('by-slug/:slug')
  @ApiOperation({ summary: 'Get plan by slug' })
  bySlug(@Param('slug') slug: string) {
    return this.plans.findBySlug(slug);
  }

  // ---- Admin ----
  @ApiBearerAuth()
  @Get('admin')
  @RequirePermissions(['read:plans'])
  @ApiOperation({ summary: 'List all plans incl. hidden (admin)' })
  list(@Query() query: Record<string, unknown>) {
    return this.plans.listAll(query);
  }

  @ApiBearerAuth()
  @Post()
  @RequirePermissions(['create:plans'])
  @ApiOperation({ summary: 'Create a plan (admin)' })
  create(@Body(new ZodValidationPipe(PlansSchemas.create)) body: any) {
    return this.plans.create(body);
  }

  @ApiBearerAuth()
  @Post('categories')
  @RequirePermissions(['create:plans'])
  @ApiOperation({ summary: 'Create plan category (admin)' })
  createCategory(@Body(new ZodValidationPipe(PlansSchemas.createCategory)) body: any) {
    return this.plans.createCategory(body);
  }

  @ApiBearerAuth()
  @Patch(':publicId')
  @RequirePermissions(['update:plans'])
  @ApiOperation({ summary: 'Update a plan (admin)' })
  update(
    @Param('publicId') publicId: string,
    @Body(new ZodValidationPipe(PlansSchemas.update)) body: any,
  ) {
    return this.plans.update(publicId, body);
  }

  @ApiBearerAuth()
  @Delete(':publicId')
  @RequirePermissions(['delete:plans'])
  @ApiOperation({ summary: 'Archive a plan (admin)' })
  remove(@Param('publicId') publicId: string) {
    return this.plans.remove(publicId);
  }
}
