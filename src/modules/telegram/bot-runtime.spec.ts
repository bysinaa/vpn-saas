jest.mock('@/config', () => ({
  config: {
    telegram: { adminIds: ['111', '222'] },
    superAdmin: { telegramId: '333' },
    app: { name: 'TAZAXY' },
  },
}));
jest.mock('@/common/prisma/prisma.service', () => ({ PrismaService: class PrismaService {} }));
jest.mock('@/common/redis/redis.service', () => ({ RedisService: class RedisService {} }));

import { BotRuntime } from './bot-runtime';

describe('BotRuntime receipt notifications', () => {
  it('delivers simultaneous receipts independently to configured and database admins', async () => {
    const prisma = {
      user: {
        findMany: jest.fn().mockResolvedValue([
          { telegramId: '333' },
          { telegramId: '444' },
        ]),
      },
    };
    const sendPhoto = jest.fn().mockResolvedValue(undefined);
    const sendMessage = jest.fn().mockResolvedValue(undefined);
    const runtime = new BotRuntime(prisma as any, {} as any);
    runtime.setBot({ telegram: { sendPhoto, sendMessage } } as any);
    const keyboard = { reply_markup: { inline_keyboard: [[{ callback_data: 'approve' }]] } };

    await Promise.all([
      runtime.notifyAdminsWithPhoto({ fileId: 'photo-1', caption: 'receipt-1', keyboard }),
      runtime.notifyAdminsWithPhoto({ fileId: 'photo-2', caption: 'receipt-2', keyboard }),
    ]);

    expect(sendPhoto).toHaveBeenCalledTimes(8);
    for (const adminId of ['111', '222', '333', '444']) {
      expect(sendPhoto).toHaveBeenCalledWith(
        adminId,
        'photo-1',
        expect.objectContaining({ caption: 'receipt-1', reply_markup: keyboard.reply_markup }),
      );
      expect(sendPhoto).toHaveBeenCalledWith(
        adminId,
        'photo-2',
        expect.objectContaining({ caption: 'receipt-2', reply_markup: keyboard.reply_markup }),
      );
    }
  });

  it('falls back to a text notification with the same buttons when photo delivery fails', async () => {
    const prisma = { user: { findMany: jest.fn().mockResolvedValue([]) } };
    const sendPhoto = jest.fn().mockRejectedValue(new Error('photo failed'));
    const sendMessage = jest.fn().mockResolvedValue(undefined);
    const runtime = new BotRuntime(prisma as any, {} as any);
    runtime.setBot({ telegram: { sendPhoto, sendMessage } } as any);
    const keyboard = { reply_markup: { inline_keyboard: [[{ callback_data: 'approve' }]] } };

    await runtime.notifyAdminsWithPhoto({ fileId: 'photo', caption: 'receipt', keyboard });

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage).toHaveBeenCalledWith('333', 'receipt', {
      reply_markup: keyboard.reply_markup,
    });
  });
});
