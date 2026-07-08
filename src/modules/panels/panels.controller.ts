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
import { PanelsService } from './panels.service';
import {
  CreatePanelInput,
  createPanelSchema,
  UpdatePanelInput,
  updatePanelSchema,
} from './panels.schemas';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';

@Controller('panels')
export class PanelsController {
  constructor(private readonly panels: PanelsService) {}

  @Get()
  @RequirePermissions(['read:panels'])
  list(@Query() query: Record<string, unknown>) {
    return this.panels.list(query);
  }

  @Post()
  @RequirePermissions(['manage:panels'])
  @UsePipes(new ZodValidationPipe(createPanelSchema))
  create(@Body() body: CreatePanelInput) {
    return this.panels.create(body);
  }

  @Patch(':id')
  @RequirePermissions(['manage:panels'])
  @UsePipes(new ZodValidationPipe(updatePanelSchema))
  update(@Param('id') id: string, @Body() body: UpdatePanelInput) {
    return this.panels.update(BigInt(id), body as Record<string, unknown>);
  }

  @Delete(':id')
  @RequirePermissions(['manage:panels'])
  delete(@Param('id') id: string) {
    return this.panels.delete(BigInt(id));
  }

  @Post(':id/health-check')
  @RequirePermissions(['manage:panels'])
  checkHealth(@Param('id') id: string) {
    return this.panels.checkHealth(BigInt(id));
  }
}
