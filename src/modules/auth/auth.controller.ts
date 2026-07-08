import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { AuthSchemas } from './auth.schemas';
import { Public } from './decorators/public.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import type { AuthenticatedUser } from './auth.types';
import type { FastifyRequest } from 'fastify';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Register a new user with email/password' })
  register(
    @Body(new ZodValidationPipe(AuthSchemas.register)) body: { email: string; password: string; username?: string },
    @Req() req: FastifyRequest,
  ) {
    return this.auth.registerEmail(body);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Login with email/telegramId + password' })
  login(
    @Body(new ZodValidationPipe(AuthSchemas.login)) body: { email?: string; telegramId?: string; password?: string },
    @Req() req: FastifyRequest,
  ) {
    return this.auth.login({
      ...body,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate refresh token and issue new pair' })
  refresh(
    @Body(new ZodValidationPipe(AuthSchemas.refresh)) body: { refreshToken: string },
    @Req() req: FastifyRequest,
  ) {
    return this.auth.refresh(body.refreshToken, req.headers['user-agent'], req.ip);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke current session' })
  async logout(@Req() req: FastifyRequest) {
    const header = req.headers.authorization as string | undefined;
    const token = header?.split(' ')[1] ?? '';
    await this.auth.logout(token);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'Get current authenticated user' })
  me(@CurrentUser() user: AuthenticatedUser) {
    return {
      id: user.id.toString(),
      publicId: user.publicId,
      role: user.role,
      email: user.email ?? null,
      telegramId: user.telegramId ?? null,
      permissions: user.permissions ?? [],
    };
  }
}
