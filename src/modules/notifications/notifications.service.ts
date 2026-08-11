import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { BroadcastService } from './broadcast.service';
import type { NotificationChannel, UserRole } from '@prisma/client';

type SendNotificationInput = {
  channel: NotificationChannel | string;
  userId: bigint;
  event?: string;
  type?: string;
  title: string;
  body: string;
  payload?: unknown;
  metadata?: Record<string, unknown>;
};

type BroadcastTargetRole = UserRole | 'ALL';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly broadcast: BroadcastService,
  ) {}

  async sendToUser(
    userId: bigint,
    data: {
      channel: NotificationChannel | string;
      event: string;
      title: string;
      body: string;
      payload?: unknown;
    },
  ) {
    return this.prisma.notification.create({
      data: {
        userId,
        channel: data.channel as NotificationChannel,
        event: data.event,
        title: data.title,
        body: data.body,
        payload: data.payload as any,
      },
    });
  }

  async send(data: SendNotificationInput) {
    const notification = await this.sendToUser(data.userId, {
      channel: data.channel,
      event: data.event ?? data.type ?? 'NOTIFICATION',
      title: data.title,
      body: data.body,
      payload: data.payload ?? data.metadata,
    });
    if (data.channel !== 'TELEGRAM') return notification;
    try {
      await this.broadcast.sendToUser(data.userId, `${data.title}\n\n${data.body}`);
      return this.prisma.notification.update({
        where: { id: notification.id },
        data: { status: 'SENT', sentAt: new Date() },
      });
    } catch (error) {
      await this.prisma.notification.update({
        where: { id: notification.id },
        data: { status: 'FAILED', error: error instanceof Error ? error.message : 'Send failed' },
      });
      throw error;
    }
  }

  async createBroadcast(input: {
    message: string;
    targetRole?: BroadcastTargetRole;
    createdBy?: string;
  }): Promise<{ id: string; total: number }> {
    return this.broadcast.createAndEnqueue(input);
  }

  async listBroadcasts(limit = 20) {
    return this.broadcast.list(limit);
  }

  async getBroadcastStats(broadcastId: string) {
    return this.broadcast.getStats(broadcastId);
  }
}
