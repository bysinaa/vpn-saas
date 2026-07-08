import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { BusinessException } from '@/common/exceptions/business.exception';
import { config } from '@/config';
import { Telegraf } from 'telegraf';
import { ProxyHttpService } from '@/common/proxy/proxy-http.service';
import type { UserRole } from '@prisma/client';

type BroadcastTargetRole = UserRole | 'ALL';

@Injectable()
export class BroadcastService {
  private readonly logger = new Logger(BroadcastService.name);
  private bot: Telegraf | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly proxy: ProxyHttpService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Bot will be initialized lazily when needed
  }

  private async ensureBot(): Promise<void> {
    if (!this.bot && config.telegram.botToken) {
      const agent = await this.proxy.ensureAgent();
      this.bot = new Telegraf(
        config.telegram.botToken,
        agent ? ({ telegram: { agent } } as any) : {},
      );
    }
  }

  /** Ensure a bot instance is available for sending. */
  private async ensureBotForSending(): Promise<void> {
    if (this.bot) return; // Already set via setBot()
    if (!config.telegram.botToken) {
      this.logger.error('Telegram bot token not configured — cannot send broadcast');
      return;
    }
    const agent = await this.proxy.ensureAgent();
    this.bot = new Telegraf(
      config.telegram.botToken,
      agent ? ({ telegram: { agent } } as any) : {},
    );
    // Start polling if not already started (lazy init fallback).
    try {
      await this.bot.launch();
      this.logger.log('Broadcast bot launched (lazy init)');
    } catch (err: any) {
      this.logger.warn(`Broadcast bot launch failed: ${err?.message ?? err} — will use setBot instance`);
      // Reset to null so next call retries with setBot.
      this.bot = null;
    }
  }

  /** Create a broadcast record and enqueue individual send jobs. */
  async createAndEnqueue(input: {
    message: string;
    targetRole?: BroadcastTargetRole;
    createdBy?: string;
  }): Promise<{ id: string; total: number }> {
    const targetRole = input.targetRole ?? 'ALL';

    // Count target users
    const where: any = { status: 'ACTIVE' };
    if (targetRole !== 'ALL') {
      where.role = targetRole;
    }
    const total = await this.prisma.user.count({ where });

    // Create broadcast record
    const broadcast = await this.prisma.broadcast.create({
      data: {
        name: `Broadcast ${new Date().toISOString()}`,
        segment: 'ALL',
        message: input.message,
        totalCount: total,
        sentCount: 0,
        failedCount: 0,
        status: 'SCHEDULED',
        metadata: {
          targetRole,
          createdBy: input.createdBy ?? 'admin',
        },
      },
    });

    // Process broadcast directly (no separate queue worker needed).
    // Fire-and-forget: errors are logged inside processBroadcast.
    this.processBroadcast(broadcast.id.toString()).catch((err) => {
      this.logger.error(`Broadcast ${broadcast.id} processing failed: ${err?.message ?? err}`);
    });

    return { id: broadcast.id.toString(), total };
  }

  /** Process a broadcast: send to all target users with graceful failure handling. */
  async processBroadcast(broadcastId: string): Promise<void> {
    const broadcast = await this.prisma.broadcast.findUnique({
      where: { id: BigInt(broadcastId) },
    });
    if (!broadcast) {
      this.logger.error(`Broadcast ${broadcastId} not found`);
      return;
    }

    await this.prisma.broadcast.update({
      where: { id: BigInt(broadcastId) },
      data: { status: 'RUNNING', startedAt: new Date() },
    });

    // Ensure bot is available — prefer the shared instance set via setBot().
    if (!this.bot) {
      await this.ensureBotForSending();
    }

    if (!this.bot) {
      this.logger.error('Telegram bot not available for broadcast — no bot instance set');
      await this.prisma.broadcast.update({
        where: { id: BigInt(broadcastId) },
        data: { status: 'FAILED' },
      });
      return;
    }

    const targetRole = this.getTargetRole(broadcast.metadata);
    const where: any = { status: 'ACTIVE', telegramId: { not: null } };
    if (targetRole !== 'ALL') {
      where.role = targetRole;
    }

    const users = await this.prisma.user.findMany({
      where,
      select: { id: true, telegramId: true, username: true, firstName: true },
    });

    let sent = 0;
    let failed = 0;

    for (const user of users) {
      try {
        await this.bot.telegram.sendMessage(user.telegramId!, broadcast.message);
        sent++;
        // Update progress periodically
        if (sent % 10 === 0) {
          await this.prisma.broadcast.update({
            where: { id: BigInt(broadcastId) },
            data: { sentCount: sent, failedCount: failed },
          });
        }
      } catch (err: any) {
        failed++;
        this.logger.warn(
          `Broadcast ${broadcastId}: failed to send to user ${user.id} (${user.telegramId}): ${err?.message ?? err}`,
        );
        // Continue sending to remaining users — don't abort on individual failures
      }
      // Rate limit: ~25 messages/second to respect Telegram API limits
      await new Promise((r) => setTimeout(r, 40));
    }

    await this.prisma.broadcast.update({
      where: { id: BigInt(broadcastId) },
      data: {
        sentCount: sent,
        failedCount: failed,
        status: 'COMPLETED',
        completedAt: new Date(),
      },
    });

    this.logger.log(`Broadcast ${broadcastId} completed: ${sent} sent, ${failed} failed`);
  }

  /** List recent broadcasts. */
  async list(limit = 20) {
    const broadcasts = await this.prisma.broadcast.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return broadcasts.map((b) => ({
      id: b.id.toString(),
      message: b.message,
      targetRole: this.getTargetRole(b.metadata),
      totalRecipients: b.totalCount,
      sentCount: b.sentCount,
      failedCount: b.failedCount,
      status: b.status,
      createdAt: b.createdAt,
      completedAt: b.completedAt,
    }));
  }

  /** Get stats for a specific broadcast. */
  async getStats(broadcastId: string) {
    const b = await this.prisma.broadcast.findUnique({
      where: { id: BigInt(broadcastId) },
    });
    if (!b) throw BusinessException.notFound('Broadcast not found');
    return {
      id: b.id.toString(),
      message: b.message,
      targetRole: this.getTargetRole(b.metadata),
      totalRecipients: b.totalCount,
      sentCount: b.sentCount,
      failedCount: b.failedCount,
      status: b.status,
      createdAt: b.createdAt,
      completedAt: b.completedAt,
    };
  }

  /** Set the shared Telegraf bot instance (called by TelegramBotService). */
  setBot(bot: Telegraf): void {
    this.bot = bot;
  }

  /** Send a message to all active users directly (from admin bot command). */
  async sendToAllActiveUsers(message: string, createdBy: string): Promise<{ sent: number; failed: number; total: number }> {
    const where: any = { status: 'ACTIVE', telegramId: { not: null } };
    const users = await this.prisma.user.findMany({
      where,
      select: { id: true, telegramId: true },
    });

    if (!this.bot) {
      this.logger.error('No bot instance available for broadcast — setBot() was not called');
      return { sent: 0, failed: users.length, total: users.length };
    }

    let sent = 0;
    let failed = 0;

    for (const user of users) {
      try {
        await this.bot.telegram.sendMessage(user.telegramId!, message);
        sent++;
      } catch (err: any) {
        failed++;
        this.logger.warn(`Broadcast to ${user.telegramId} failed: ${err?.message ?? err}`);
      }
      // Rate limit: ~25 messages/second to respect Telegram API limits
      await new Promise((r) => setTimeout(r, 40));
    }

    // Log as broadcast record
    await this.prisma.broadcast.create({
      data: {
        name: `Bot broadcast ${new Date().toISOString()}`,
        segment: 'ALL',
        message,
        totalCount: users.length,
        sentCount: sent,
        failedCount: failed,
        status: 'COMPLETED',
        completedAt: new Date(),
        metadata: { createdBy },
      },
    });

    this.logger.log(`Direct broadcast completed: ${sent}/${users.length} sent, ${failed} failed`);
    return { sent, failed, total: users.length };
  }

  private getTargetRole(metadata: unknown): BroadcastTargetRole {
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      const targetRole = (metadata as { targetRole?: unknown }).targetRole;
      if (typeof targetRole === 'string') {
        return targetRole as BroadcastTargetRole;
      }
    }
    return 'ALL';
  }
}
