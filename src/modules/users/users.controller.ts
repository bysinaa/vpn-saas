import { Body, Controller, Delete, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UsersSchemas } from './users.schemas';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get my profile' })
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.users.findById(user.id);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update my profile' })
  updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(UsersSchemas.updateProfile)) body: any,
  ) {
    return this.users.updateProfile(user.id, body);
  }

  @Get()
  @RequirePermissions(['read:users'])
  @ApiOperation({ summary: 'List users (admin)' })
  list(@Query() query: Record<string, unknown>) {
    return this.users.findPaginated(query);
  }

  @Get('stats')
  @RequirePermissions(['read:users'])
  @ApiOperation({ summary: 'User statistics (admin)' })
  stats() {
    return this.users.getStats();
  }

  @Get(':publicId')
  @RequirePermissions(['read:users'])
  @ApiOperation({ summary: 'Get user by public id (admin)' })
  byId(@Param('publicId') publicId: string) {
    return this.users.findByPublicId(publicId);
  }

  @Patch(':publicId/status')
  @RequirePermissions(['update:users'])
  @ApiOperation({ summary: 'Change user status (admin)' })
  status(
    @Param('publicId') publicId: string,
    @Body(new ZodValidationPipe(UsersSchemas.changeStatus)) body: { status: any },
  ) {
    return this.users.findByPublicId(publicId).then((u) => this.users.changeStatus(BigInt(u.id), body.status));
  }

  @Patch(':publicId/role')
  @RequirePermissions(['update:users'])
  @ApiOperation({ summary: 'Change user role (admin)' })
  role(
    @Param('publicId') publicId: string,
    @Body(new ZodValidationPipe(UsersSchemas.changeRole)) body: { role: any },
  ) {
    return this.users.findByPublicId(publicId).then((u) => this.users.changeRole(BigInt(u.id), body.role));
  }

  @Delete(':publicId')
  @RequirePermissions(['delete:users'])
  @ApiOperation({ summary: 'Soft delete user (admin)' })
  remove(@Param('publicId') publicId: string) {
    return this.users.findByPublicId(publicId).then((u) => this.users.softDelete(BigInt(u.id)));
  }
}
