import { Injectable, Logger } from '@nestjs/common';

// TelegramNotificationsProcessor: BullMQ disabled (Redis 3.0 incompatible).
// Telegram notifications are now sent directly via BotRuntime / TelegramBotService.

/**
 * @deprecated BullMQ processor disabled. Use BotRuntime directly.
 */
@Injectable()
export class TelegramNotificationsProcessor {
  private readonly logger = new Logger(TelegramNotificationsProcessor.name);
}