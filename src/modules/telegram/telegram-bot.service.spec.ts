jest.mock('@/config', () => ({
  config: {
    telegram: { botToken: '', useWebhook: false, webhookUrl: '' },
    superAdmin: { telegramId: '1' },
  },
}));
jest.mock('@/common/prisma/prisma.service', () => ({ PrismaService: class PrismaService {} }));
jest.mock('@/common/proxy/proxy-http.service', () => ({
  ProxyHttpService: class ProxyHttpService {},
}));
jest.mock('../auth/auth.service', () => ({ AuthService: class AuthService {} }));
jest.mock('../notifications/broadcast.service', () => ({
  BroadcastService: class BroadcastService {},
}));
jest.mock('./bot-runtime', () => ({ BotRuntime: class BotRuntime {} }));
jest.mock('./flows/language.flow', () => ({ LanguageFlow: class LanguageFlow {} }));
jest.mock('./flows/buy.flow', () => ({ BuyFlow: class BuyFlow {} }));
jest.mock('./flows/trial.flow', () => ({ TrialFlow: class TrialFlow {} }));
jest.mock('./flows/voucher.flow', () => ({ VoucherFlow: class VoucherFlow {} }));
jest.mock('./flows/wallet.flow', () => ({ WalletFlow: class WalletFlow {} }));
jest.mock('./flows/subscriptions.flow', () => ({
  SubscriptionsFlow: class SubscriptionsFlow {},
}));
jest.mock('./flows/profile.flow', () => ({ ProfileFlow: class ProfileFlow {} }));
jest.mock('./flows/referral.flow', () => ({ ReferralFlow: class ReferralFlow {} }));
jest.mock('./flows/support.flow', () => ({ SupportFlow: class SupportFlow {} }));
jest.mock('./flows/admin.flow', () => ({ AdminFlow: class AdminFlow {} }));
jest.mock('../settings/settings.service', () => ({ SettingsService: class SettingsService {} }));

import { TelegramBotService } from './telegram-bot.service';

describe('TelegramBotService main-menu navigation', () => {
  it('uses the canonical role-aware keyboard when an admin presses Home', async () => {
    const adminKeyboard = { reply_markup: { inline_keyboard: [[{ callback_data: 'admin' }]] } };
    const runtime = {
      getLocale: jest.fn().mockResolvedValue('fa'),
      getMainMenuKeyboard: jest.fn().mockResolvedValue(adminKeyboard),
      resetMenu: jest.fn().mockResolvedValue(undefined),
      setState: jest.fn().mockResolvedValue(undefined),
      editOrSend: jest.fn().mockResolvedValue(undefined),
    };
    const service = new TelegramBotService(
      {} as any,
      {} as any,
      {} as any,
      runtime as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const ctx = { from: { id: 1 } } as any;

    await (service as any).onHome(ctx);

    expect(runtime.getMainMenuKeyboard).toHaveBeenCalledWith('1');
    expect(runtime.resetMenu).toHaveBeenCalledWith('1', 'main');
    expect(runtime.setState).toHaveBeenCalledWith('1', 'idle');
    expect(runtime.editOrSend).toHaveBeenCalledWith(ctx, expect.any(String), adminKeyboard);
  });

  it('blocks a regular user until all configured channel memberships are confirmed', async () => {
    const runtime = { editOrSend: jest.fn().mockResolvedValue(undefined) };
    const settings = {
      getValue: jest.fn(async (key: string) =>
        key.endsWith('enabled')
          ? true
          : [{ chatId: '-1001', title: 'News', url: 'https://t.me/news' }],
      ),
    };
    const service = new TelegramBotService(
      { user: { findUnique: jest.fn().mockResolvedValue({ role: 'USER' }) } } as any,
      {} as any,
      {} as any,
      runtime as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      settings as any,
    );
    const next = jest.fn();
    const ctx = {
      from: { id: 2 },
      telegram: { getChatMember: jest.fn().mockResolvedValue({ status: 'left' }) },
    } as any;

    await (service as any).mandatoryJoinGuard(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(runtime.editOrSend).toHaveBeenCalledWith(
      ctx,
      expect.stringContaining('عضو شوید'),
      expect.anything(),
    );
  });

  it('exempts administrators from mandatory membership checks', async () => {
    const settings = { getValue: jest.fn() };
    const service = new TelegramBotService(
      { user: { findUnique: jest.fn().mockResolvedValue({ role: 'ADMIN' }) } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      settings as any,
    );
    const next = jest.fn().mockResolvedValue(undefined);
    await (service as any).mandatoryJoinGuard({ from: { id: 2 } } as any, next);
    expect(next).toHaveBeenCalled();
    expect(settings.getValue).not.toHaveBeenCalled();
  });

  it('dispatches mandatory-channel username text to the active admin wizard', async () => {
    const runtime = {
      getSession: jest.fn().mockResolvedValue({
        userId: 3n,
        locale: 'fa',
        state: 'admin_join_channel_awaiting_username',
      }),
    };
    const admin = { onWizardText: jest.fn().mockResolvedValue(true) };
    const service = new TelegramBotService(
      {} as any,
      {} as any,
      {} as any,
      runtime as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      admin as any,
      {} as any,
      {} as any,
    );
    const ctx = { from: { id: 1 }, message: { text: '@tazaxy' } } as any;

    await (service as any).onText(ctx);

    expect(admin.onWizardText).toHaveBeenCalledWith(ctx, '@tazaxy');
  });
});
