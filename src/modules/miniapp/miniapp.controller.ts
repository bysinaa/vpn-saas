import { Body, Controller, Get, Post, UsePipes } from '@nestjs/common';
import { z } from 'zod';
import { MiniAppService } from './miniapp.service';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';

const authSchema = z.object({
  initData: z.string().min(1),
});

type AuthInput = z.infer<typeof authSchema>;

/**
 * MiniAppController - backend API for the Telegram Mini App (Web App).
 *
 * The authenticate endpoint validates Telegram WebApp initData and returns
 * JWT tokens. All other endpoints use standard JWT auth.
 */
@Controller('miniapp')
export class MiniAppController {
  constructor(private readonly miniapp: MiniAppService) {}

  /**
   * Authenticate using Telegram WebApp initData.
   * Returns JWT access/refresh tokens + user profile.
   */
  @Public()
  @Post('auth')
  @UsePipes(new ZodValidationPipe(authSchema))
  authenticate(@Body() body: AuthInput) {
    return this.miniapp.authenticate(body.initData);
  }

  /**
   * Get the Mini App dashboard (user + wallet + subscriptions + plans)
   * in a single round-trip for fast initial load.
   */
  @Get('dashboard')
  getDashboard(@CurrentUser() user: AuthenticatedUser) {
    return this.miniapp.getDashboard(user.id);
  }
}
