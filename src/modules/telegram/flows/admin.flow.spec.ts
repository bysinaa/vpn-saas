jest.mock('@/config', () => ({
  config: {
    superAdmin: { telegramId: '1' },
    payments: { online: { merchantId: '', callbackUrl: '', sandbox: true } },
  },
}));
jest.mock('../bot-runtime', () => ({ BotRuntime: class BotRuntime {} }));
jest.mock('../../admin/admin.service', () => ({ AdminService: class AdminService {} }));
jest.mock('@/common/prisma/prisma.service', () => ({ PrismaService: class PrismaService {} }));
jest.mock('../../payments/bank-cards.service', () => ({
  BankCardsService: class BankCardsService {},
  maskCardNumber: (value: string) => `••••${value.slice(-4)}`,
}));
jest.mock('../../payments/crypto-wallets.service', () => ({
  CryptoWalletsService: class CryptoWalletsService {},
}));
jest.mock('../../payments/vouchers.service', () => ({ VouchersService: class VouchersService {} }));
jest.mock('../../payments/payments.service', () => ({ PaymentsService: class PaymentsService {} }));
jest.mock('../../plans/plans.service', () => ({ PlansService: class PlansService {} }));
jest.mock('../../settings/settings.service', () => ({ SettingsService: class SettingsService {} }));
jest.mock('../../notifications/broadcast.service', () => ({
  BroadcastService: class BroadcastService {},
}));
jest.mock('../../vpn/vpn.service', () => ({ VpnService: class VpnService {} }));

import { AdminFlow } from './admin.flow';

function harness(status = 'AWAITING_VERIFY') {
  const payment = {
    id: 1n,
    publicId: 'payment-1',
    status,
    receipt: { publicId: 'receipt-1' },
  };
  const prisma = {
    payment: { findUnique: jest.fn().mockResolvedValue(payment) },
  };
  const runtime = {
    getLocale: jest.fn().mockResolvedValue('en'),
    getSession: jest.fn().mockResolvedValue({ userId: 3n }),
  };
  const payments = { verifyReceipt: jest.fn().mockResolvedValue({}) };
  const flow = new AdminFlow(
    runtime as any,
    {} as any,
    prisma as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    payments as any,
    { getSignedUrl: jest.fn() } as any,
  );
  const context = {
    from: { id: 1 },
    telegram: { sendMessage: jest.fn().mockResolvedValue({}) },
  } as any;

  return { context, flow, payments };
}

describe('AdminFlow receipt decisions', () => {
  it('delegates approval to PaymentsService using the receipt public id', async () => {
    const h = harness();

    await h.flow.approveReceipt(h.context, 'payment-1');

    expect(h.payments.verifyReceipt).toHaveBeenCalledWith({
      adminId: 3n,
      receiptPublicId: 'receipt-1',
      status: 'APPROVED',
    });
  });

  it('delegates rejection to PaymentsService using the receipt public id', async () => {
    const h = harness();

    await h.flow.rejectReceipt(h.context, 'payment-1');

    expect(h.payments.verifyReceipt).toHaveBeenCalledWith({
      adminId: 3n,
      receiptPublicId: 'receipt-1',
      status: 'REJECTED',
    });
  });

  it('delegates a repeated approval so PaymentsService can recover idempotently', async () => {
    const h = harness('CONFIRMED');

    await h.flow.approveReceipt(h.context, 'payment-1');

    expect(h.payments.verifyReceipt).toHaveBeenCalledWith({
      adminId: 3n,
      receiptPublicId: 'receipt-1',
      status: 'APPROVED',
    });
  });
});

const card = {
  publicId: '11111111-1111-4111-8111-111111111111',
  cardNumber: '6037990000000006',
  cardHolder: 'Admin Holder',
  bankName: 'Test Bank',
  shebaNumber: 'IR123456789012345678901234',
  label: 'Primary',
  isActive: true,
  isDefault: false,
};
const crypto = {
  publicId: '22222222-2222-4222-8222-222222222222',
  currency: 'USDT_TRC20',
  address: 'T-test-address',
  network: 'TRC20',
  label: 'USDT',
  instructions: 'Send only USDT',
  isActive: true,
  isDefault: false,
};

function paymentMethodsHarness(telegramId = 1, role = 'ADMIN') {
  const session: any = { userId: 3n, locale: 'en', state: 'idle' };
  const runtime = {
    getLocale: jest.fn().mockResolvedValue('en'),
    getSession: jest.fn().mockImplementation(async () => session),
    setState: jest
      .fn()
      .mockImplementation(async (_id, state, data) => Object.assign(session, { state, data })),
    clearState: jest
      .fn()
      .mockImplementation(async () => Object.assign(session, { state: 'idle', data: undefined })),
    editOrSend: jest.fn().mockResolvedValue(undefined),
    alert: jest.fn().mockResolvedValue(undefined),
    translateError: jest.fn((_locale, err) => err.message),
  };
  const bankCards = {
    listAll: jest.fn().mockResolvedValue({ data: [], meta: { total: 0 } }),
    findOne: jest.fn().mockResolvedValue(card),
    create: jest.fn().mockResolvedValue(card),
    update: jest.fn().mockResolvedValue(card),
    setActive: jest.fn().mockResolvedValue(card),
    setDefault: jest.fn().mockResolvedValue(card),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const cryptoWallets = {
    listAll: jest.fn().mockResolvedValue({ data: [], meta: { total: 0 } }),
    findOne: jest.fn().mockResolvedValue(crypto),
    create: jest.fn().mockResolvedValue(crypto),
    update: jest.fn().mockResolvedValue(crypto),
    setActive: jest.fn().mockResolvedValue(crypto),
    setDefault: jest.fn().mockResolvedValue(crypto),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const values = new Map<string, unknown>([
    ['gateway.default.enabled', false],
    ['gateway.default.merchantId', 'merchant-sensitive-1234'],
    ['gateway.default.sandbox', true],
    ['gateway.default.callbackUrl', 'https://callback.test/private-token'],
  ]);
  const settings = {
    getValue: jest.fn(async (key: string, fallback: unknown) =>
      values.has(key) ? values.get(key) : fallback,
    ),
    listAll: jest.fn().mockResolvedValue([
      {
        key: 'gateway.default.secret',
        value: 'gateway-plaintext-secret-4567',
        category: 'GATEWAY',
        type: 'STRING',
        isPublic: false,
        editable: true,
      },
    ]),
    upsert: jest.fn(async (input: any) => {
      values.set(input.key, input.type === 'BOOLEAN' ? input.value === 'true' : input.value);
      return input;
    }),
  };
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue({ role, telegramId: String(telegramId) }) },
  };
  const flow = new AdminFlow(
    runtime as any,
    {} as any,
    prisma as any,
    bankCards as any,
    cryptoWallets as any,
    {} as any,
    {} as any,
    settings as any,
    {} as any,
    {} as any,
    {} as any,
    { getSignedUrl: jest.fn() } as any,
  );
  const context = { from: { id: telegramId } } as any;
  return { flow, context, runtime, session, bankCards, cryptoWallets, settings, values };
}

function lastRender(runtime: any): { text: string; keyboard: any } {
  const calls = runtime.editOrSend.mock.calls;
  const call = calls[calls.length - 1];
  return { text: call[1], keyboard: call[2] };
}

describe('AdminFlow dashboard menu', () => {
  it('groups payment settings and omits redundant server/panel callbacks', () => {
    const h = paymentMethodsHarness();
    const keyboard = (h.flow as any).dashKeyboard('en');
    const callbacks = keyboard.reply_markup.inline_keyboard
      .flat()
      .map((button: any) => button.callback_data);

    expect(callbacks).toEqual(expect.arrayContaining(['adm:cards', 'adm:crypto', 'adm:gateway']));
    expect(callbacks).not.toEqual(expect.arrayContaining(['adm:servers', 'adm:panels']));
    expect(
      keyboard.reply_markup.inline_keyboard[2].map((button: any) => button.callback_data),
    ).toEqual(['adm:cards', 'adm:crypto']);
  });
});

describe('AdminFlow voucher creation', () => {
  it('binds an existing plan and admin-defined usage limit to a generated code', async () => {
    const session: any = { userId: 3n, state: 'idle', data: undefined };
    const runtime = {
      getLocale: jest.fn().mockResolvedValue('fa'),
      getSession: jest.fn(async () => session),
      setState: jest.fn(async (_id, state, data) => Object.assign(session, { state, data })),
      clearState: jest.fn(async () => Object.assign(session, { state: 'idle', data: undefined })),
      editOrSend: jest.fn(),
      alert: jest.fn(),
      translateError: jest.fn((_locale, err) => err.message),
    };
    const plan = {
      id: 9n,
      publicId: '99999999-9999-4999-8999-999999999999',
      name: 'ماهانه',
      price: 1000n,
      currency: 'IRT',
      priority: 1,
      isEnabled: true,
      status: 'ACTIVE',
    };
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ role: 'ADMIN' }) },
      plan: {
        findMany: jest.fn().mockResolvedValue([plan]),
        findUnique: jest.fn().mockResolvedValue(plan),
      },
    };
    const vouchers = {
      generate: jest.fn().mockResolvedValue([{ code: 'CODE123456', maxRedemptions: 5 }]),
    };
    const flow = new AdminFlow(
      runtime as any,
      {} as any,
      prisma as any,
      {} as any,
      {} as any,
      vouchers as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const context = { from: { id: 1 } } as any;

    await flow.onVoucherAction(context, 'new');
    expect(JSON.stringify(runtime.editOrSend.mock.calls.at(-1))).toContain(
      `avoucher:plan:${plan.publicId}`,
    );

    await flow.onVoucherAction(context, 'plan', plan.publicId);
    expect(session.state).toBe('admin_voucher_awaiting_uses');

    await flow.onWizardText(context, '5');
    expect(vouchers.generate).toHaveBeenCalledWith({ planId: 9n, maxRedemptions: 5 }, 3n);
    expect(session.state).toBe('idle');
  });
});

describe('AdminFlow payment-method management', () => {
  it('protects section views and wizard text from non-admin users', async () => {
    const h = paymentMethodsHarness(2, 'USER');
    await h.flow.showSection(h.context, 'cards');
    expect(h.bankCards.listAll).not.toHaveBeenCalled();
    expect(h.runtime.editOrSend).toHaveBeenCalled();

    h.session.state = 'admin_card_awaiting_field';
    h.session.data = { adminWizard: 'card_create', adminField: 'number', adminDraft: {} };
    await expect(h.flow.onWizardText(h.context, '6037990000000006')).resolves.toBe(false);
    expect(h.bankCards.create).not.toHaveBeenCalled();
  });

  it('renders actionable card empty state, masked detail, and Back/Home navigation', async () => {
    const h = paymentMethodsHarness();
    await h.flow.showSection(h.context, 'cards');
    const empty = lastRender(h.runtime);
    expect(empty.text).toContain('No cards yet');
    expect(JSON.stringify(empty.keyboard)).toContain('acard:new:0');
    expect(JSON.stringify(empty.keyboard)).toContain('adm:dash');
    expect(JSON.stringify(empty.keyboard)).toContain('home');

    await h.flow.onCardAction(h.context, 'detail', card.publicId);
    const detail = lastRender(h.runtime);
    expect(detail.text).not.toContain(card.cardNumber);
    expect(detail.text).not.toContain(card.shebaNumber);
    expect(detail.text).toContain('0006');
    expect(JSON.stringify(detail.keyboard)).toContain('adm:cards');
    expect(JSON.stringify(detail.keyboard)).toContain('home');
  });

  it('creates and edits cards through BankCardsService with the session DB admin id', async () => {
    const h = paymentMethodsHarness();
    await h.flow.onCardAction(h.context, 'new', '');
    for (const value of ['6037990000000006', 'Admin Holder', 'Test Bank', '/skip', '/skip']) {
      await h.flow.onWizardText(h.context, value);
    }
    expect(h.bankCards.create).toHaveBeenCalledWith(
      expect.objectContaining({
        cardNumber: '6037990000000006',
        cardHolder: 'Admin Holder',
        bankName: 'Test Bank',
      }),
      3n,
    );

    await h.flow.onCardEditField(h.context, 'bank', card.publicId);
    await h.flow.onWizardText(h.context, 'New Bank');
    expect(h.bankCards.update).toHaveBeenCalledWith(card.publicId, { bankName: 'New Bank' }, 3n);

    await h.flow.onCardAction(h.context, 'default', card.publicId);
    expect(h.bankCards.setDefault).toHaveBeenCalledWith(card.publicId, 3n);
    await h.flow.onCardAction(h.context, 'delete', card.publicId);
    expect(h.bankCards.remove).toHaveBeenCalledWith(card.publicId, 3n);
  });

  it('creates, edits, toggles, defaults, and safely confirms crypto destinations via the service', async () => {
    const h = paymentMethodsHarness();
    await h.flow.onCryptoAction(h.context, 'choose', 'USDT_TRC20');
    for (const value of ['T-test-address', 'TRC20', '/skip', '/skip']) {
      await h.flow.onWizardText(h.context, value);
    }
    expect(h.cryptoWallets.create).toHaveBeenCalledWith(
      expect.objectContaining({
        currency: 'USDT_TRC20',
        address: 'T-test-address',
        network: 'TRC20',
      }),
      3n,
    );

    await h.flow.onCryptoEditField(h.context, 'network', crypto.publicId);
    await h.flow.onWizardText(h.context, 'BEP20');
    expect(h.cryptoWallets.update).toHaveBeenCalledWith(crypto.publicId, { network: 'BEP20' }, 3n);
    await h.flow.onCryptoAction(h.context, 'toggle', crypto.publicId);
    expect(h.cryptoWallets.setActive).toHaveBeenCalledWith(crypto.publicId, false, 3n);
    await h.flow.onCryptoAction(h.context, 'default', crypto.publicId);
    expect(h.cryptoWallets.setDefault).toHaveBeenCalledWith(crypto.publicId, 3n);

    await h.flow.onCryptoAction(h.context, 'confirmDelete', crypto.publicId);
    expect(h.cryptoWallets.remove).not.toHaveBeenCalled();
    expect(JSON.stringify(lastRender(h.runtime).keyboard)).toContain(
      `acrypto:delete:${crypto.publicId}`,
    );
    await h.flow.onCryptoAction(h.context, 'delete', crypto.publicId);
    expect(h.cryptoWallets.remove).toHaveBeenCalledWith(crypto.publicId, 3n);
  });

  it('updates runtime gateway settings without echoing merchant or callback secrets', async () => {
    const h = paymentMethodsHarness();
    await h.flow.showSection(h.context, 'gateway');
    expect(lastRender(h.runtime).text).not.toContain('merchant-sensitive-1234');
    expect(lastRender(h.runtime).text).not.toContain('private-token');
    expect(lastRender(h.runtime).text).toContain('1234');

    await h.flow.onGatewayAction(h.context, 'toggle');
    expect(h.settings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'gateway.default.enabled',
        value: 'true',
        type: 'BOOLEAN',
        isPublic: false,
      }),
    );
    await h.flow.onGatewayAction(h.context, 'merchant');
    await h.flow.onWizardText(h.context, 'new-merchant-secret-9876');
    expect(h.settings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'gateway.default.merchantId',
        value: 'new-merchant-secret-9876',
        isPublic: false,
      }),
    );
    expect(lastRender(h.runtime).text).not.toContain('new-merchant-secret-9876');
    expect(lastRender(h.runtime).text).toContain('9876');

    await h.flow.showSection(h.context, 'settings');
    expect(lastRender(h.runtime).text).not.toContain('gateway-plaintext-secret-4567');
    expect(lastRender(h.runtime).text).toContain('4567');
  });
});

describe('AdminFlow mandatory channel membership', () => {
  it('validates bot administration and stores a configured public channel', async () => {
    const h = paymentMethodsHarness();
    const telegram = {
      getChat: jest.fn().mockResolvedValue({
        id: -100123,
        type: 'channel',
        username: 'news_channel',
        title: 'News',
      }),
      getMe: jest.fn().mockResolvedValue({ id: 99 }),
      getChatMember: jest.fn().mockResolvedValue({ status: 'administrator' }),
    };
    h.context.telegram = telegram;

    await h.flow.onMandatoryJoinAction(h.context, 'add', '');
    await h.flow.onWizardText(h.context, '@news_channel');

    expect(h.settings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'telegram.mandatoryJoin.channels',
        type: 'JSON',
        value: expect.stringContaining('https://t.me/news_channel'),
      }),
    );
    expect(telegram.getChatMember).toHaveBeenCalledWith(-100123, 99);
  });
});
