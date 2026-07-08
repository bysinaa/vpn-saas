import { Body, Controller, Headers, Post } from '@nestjs/common';
import { TelegramBotService } from './telegram-bot.service';
import { config } from '@/config';
import { Public } from '../auth/decorators/public.decorator';
import { safeEqual } from '@/common/utils/crypto.util';

/**
 * TelegramWebhookController - receives Telegram update payloads.
 * Validates the secret path segment to ensure only Telegram can call it.
 */
@Controller('telegram')
export class TelegramController {
  constructor(private readonly bot: TelegramBotService) {}

  @Public()
  @Post('webhook')
  async webhook(
    @Body() update: unknown,
    @Headers('x-telegram-bot-api-secret-token') secretToken?: string,
  ) {
    if (!config.telegram.useWebhook) {
      return { ok: true, skipped: true };
    }
    // Optional secret token validation (set when configuring webhook)
    if (config.security.webhookSecret && secretToken) {
      if (!safeEqual(secretToken, config.security.webhookSecret)) {
        return { ok: false, error: 'invalid secret' };
      }
    }
    await this.bot.handleUpdate(update);
    return { ok: true };
  }
}
