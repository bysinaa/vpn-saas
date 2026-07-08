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
    return this.sendToUser(data.userId, {
      channel: data.channel,
      event: data.event ?? data.type ?? 'NOTIFICATION',
      title: data.title,
      body: data.body,
      payload: data.payload ?? data.metadata,
    });
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