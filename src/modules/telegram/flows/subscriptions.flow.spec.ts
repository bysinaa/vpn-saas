jest.mock('@/common/prisma/prisma.service', () => ({ PrismaService: class PrismaService {} }));
jest.mock('../bot-runtime', () => ({ BotRuntime: class BotRuntime {} }));
jest.mock('../../subscriptions/subscriptions.service', () => ({
  SubscriptionsService: class SubscriptionsService {},
}));
jest.mock('../../orders/orders.service', () => ({ OrdersService: class OrdersService {} }));
jest.mock('../../vpn/vpn.service', () => ({ VpnService: class VpnService {} }));

import { subscriptionDetailKeyboard } from '../keyboards';
import { SubscriptionsFlow } from './subscriptions.flow';

describe('SubscriptionsFlow paid lifecycle', () => {
  const userId = 3n;
  const telegramId = '123';
  const ctx = { from: { id: Number(telegramId) } } as any;

  function runtime() {
    return {
      getLocale: jest.fn().mockResolvedValue('en'),
      getSession: jest.fn().mockResolvedValue({ userId, data: {} }),
      setState: jest.fn().mockResolvedValue(undefined),
      pushMenu: jest.fn().mockResolvedValue(undefined),
      alert: jest.fn().mockResolvedValue(undefined),
      render: jest.fn().mockResolvedValue(undefined),
      withLock: jest.fn(async (_id, fn) => fn()),
      translateError: jest.fn((_, error) => error.message),
    };
  }

  it('renders live usage, remaining traffic, status, and one effective expiry', async () => {
    const rt = runtime();
    const dbExpiry = new Date('2030-01-01T00:00:00Z');
    const panelExpiry = new Date('2031-02-03T00:00:00Z');
    const prisma = {
      subscription: {
        findUnique: jest.fn().mockResolvedValue({
          id: 9n,
          publicId: 'subscription-1',
          userId,
          status: 'ACTIVE',
          usedTrafficBytes: 1n,
          trafficLimitBytes: 10n,
          expiresAt: dbExpiry,
          createdAt: new Date('2029-01-01T00:00:00Z'),
          plan: { name: 'Live Plan' },
          vpnUser: { metadata: {} },
          servers: [],
        }),
      },
    };
    const vpn = {
      getUsageFromPanel: jest.fn().mockResolvedValue({
        usedBytes: 4n,
        totalBytes: 10n,
        expiresAt: panelExpiry,
        status: 'LIMITED',
      }),
    };
    const flow = new SubscriptionsFlow(rt as any, prisma as any, {} as any, {} as any, vpn as any);

    await flow.showDetail(ctx, 'subscription-1');

    const message = rt.render.mock.calls[0][1] as string;
    expect(message).toContain('LIMITED');
    expect(message).toContain('Remaining: 6 B');
    expect(message).toContain('3 Feb 2031');
    expect(message).not.toContain('1 Jan 2030');
    expect(message.toLowerCase()).not.toContain('v2ray');
  });

  it('creates an unpaid extension order instead of mutating the subscription', async () => {
    const rt = runtime();
    const plan = { publicId: 'plan-1', name: 'Plan' };
    const prisma = {
      subscription: {
        findUnique: jest.fn().mockResolvedValue({
          id: 9n,
          publicId: 'subscription-1',
          userId,
          plan,
        }),
      },
    };
    const orders = {
      create: jest.fn().mockResolvedValue({
        publicId: 'order-1',
        totalAmount: '500',
        currency: 'IRT',
      }),
    };
    const subscriptions = { extend: jest.fn(), renew: jest.fn() };
    const flow = new SubscriptionsFlow(
      rt as any,
      prisma as any,
      subscriptions as any,
      orders as any,
      {} as any,
    );

    await flow.promptExtend(ctx, 'subscription-1');

    expect(orders.create).toHaveBeenCalledWith({
      userId,
      planPublicId: 'plan-1',
      type: 'EXTEND',
      targetSubscriptionPublicId: 'subscription-1',
    });
    expect(rt.setState).toHaveBeenCalledWith(telegramId, 'buy_awaiting_payment', {
      orderId: 'order-1',
    });
    expect(subscriptions.extend).not.toHaveBeenCalled();
    expect(subscriptions.renew).not.toHaveBeenCalled();
  });

  it('does not expose an upgrade callback', () => {
    const keyboard = subscriptionDetailKeyboard('en', 'subscription-1') as any;
    const callbacks = keyboard.reply_markup.inline_keyboard
      .flat()
      .map((button: any) => button.callback_data)
      .filter(Boolean);
    expect(callbacks.some((callback: string) => callback.startsWith('subupgrade:'))).toBe(false);
  });
});
