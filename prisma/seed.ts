/* eslint-disable */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // ---------- Permissions ----------
  const resources = ['users', 'orders', 'payments', 'subscriptions', 'servers', 'panels', 'tickets', 'plans', 'wallets', 'settings', 'reports', 'broadcasts', 'education', 'affiliates', 'notifications'];
  const actions = ['read', 'create', 'update', 'delete'];
  const permissions: { id: bigint }[] = [];
  for (const resource of resources) {
    for (const action of actions) {
      const p = await prisma.permission.upsert({
        where: { name: `${action}:${resource}` },
        update: {},
        create: { name: `${action}:${resource}`, resource, action },
      });
      permissions.push(p as unknown as { id: bigint });
    }
  }

  // ---------- Roles ----------
  const allPerms = await prisma.permission.findMany();
  const superAdminRole = await prisma.role.upsert({
    where: { name: 'SUPER_ADMIN' },
    update: { isSystem: true },
    create: { name: 'SUPER_ADMIN', description: 'Full access', isSystem: true },
  });
  // SUPER_ADMIN gets all permissions
  await prisma.rolePermission.deleteMany({ where: { roleId: superAdminRole.id } });
  await prisma.rolePermission.createMany({
    data: allPerms.map((p) => ({ roleId: superAdminRole.id, permissionId: p.id })),
    skipDuplicates: true,
  });

  const adminRole = await prisma.role.upsert({
    where: { name: 'ADMIN' },
    update: {},
    create: { name: 'ADMIN', description: 'Admin access', isSystem: true },
  });

  const operatorRole = await prisma.role.upsert({
    where: { name: 'OPERATOR' },
    update: {},
    create: { name: 'OPERATOR', description: 'Operator access', isSystem: true },
  });

  const supportRole = await prisma.role.upsert({
    where: { name: 'SUPPORT' },
    update: {},
    create: { name: 'SUPPORT', description: 'Support agent', isSystem: true },
  });

  const userRole = await prisma.role.upsert({
    where: { name: 'USER' },
    update: {},
    create: { name: 'USER', description: 'Standard user', isSystem: true },
  });

  // ---------- Super Admin ----------
  const email = process.env.SUPER_ADMIN_EMAIL || 'admin@vpn-saas.local';
  const password = process.env.SUPER_ADMIN_PASSWORD || 'ChangeMe!2024';
  const passwordHash = await bcrypt.hash(password, 12);
  const telegramId = process.env.SUPER_ADMIN_TELEGRAM_ID;

  await prisma.user.upsert({
    where: { email },
    update: {
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      passwordHash,
      // Link the Telegram account to the existing super admin when provided,
      // so the user's /start matches the SUPER_ADMIN row instead of creating
      // a new USER (see AuthService.mintForTelegramUser lookup by telegramId).
      ...(telegramId ? { telegramId } : {}),
    },
    create: {
      email,
      username: 'superadmin',
      firstName: 'Super',
      lastName: 'Admin',
      passwordHash,
      telegramId: telegramId,
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      language: 'EN',
      isEmailVerified: true,
      referralCode: 'ADMIN-' + Math.random().toString(36).slice(2, 10).toUpperCase(),
    },
  });

  // ---------- Default System Settings ----------
  // Currency is Toman (Iranian Rial /10). All monetary settings are stored as
  // integer "minor units" (i.e. Toman, no fractional part). 50,000 Toman =
  // 50000 minor units.
  const defaultSettings = [
    // --- Trial (spec #1) ---
    { key: 'trial.enabled', value: 'true', category: 'TRIAL', type: 'BOOLEAN', isPublic: true, description: 'Enable trial subscriptions' },
    { key: 'trial.durationDays', value: '3', category: 'TRIAL', type: 'NUMBER', isPublic: true, description: 'Trial duration in days' },
    { key: 'trial.trafficLimitGb', value: '0.5', category: 'TRIAL', type: 'NUMBER', isPublic: true, description: 'Trial traffic limit in GB (0.5 = 500MB)' },
    { key: 'trial.perAccountLimit', value: '1', category: 'TRIAL', type: 'NUMBER', description: 'Trials allowed per Telegram account' },
    { key: 'trial.cooldownHours', value: '0', category: 'TRIAL', type: 'NUMBER', description: 'Cooldown between trials (hours)' },
    { key: 'trial.dailyGlobalLimit', value: '50', category: 'TRIAL', type: 'NUMBER', description: 'Max trials created per day (anti-abuse)' },
    // --- Referral (spec #8) ---
    { key: 'referral.enabled', value: 'true', category: 'REFERRAL', type: 'BOOLEAN', isPublic: true, description: 'Enable referral system' },
    { key: 'referral.referrerReward', value: '50000', category: 'REFERRAL', type: 'NUMBER', isPublic: true, description: 'Reward for referrer on signup (minor Toman)' },
    { key: 'referral.referredReward', value: '50000', category: 'REFERRAL', type: 'NUMBER', isPublic: true, description: 'Welcome reward for referred user (minor Toman)' },
    { key: 'referral.commissionPercent', value: '10', category: 'REFERRAL', type: 'NUMBER', isPublic: true, description: 'Commission percentage on referred users purchases' },
    { key: 'referral.maxBonus', value: '5000000', category: 'REFERRAL', type: 'NUMBER', description: 'Maximum total referral bonus per user (minor Toman)' },
    { key: 'referral.levels', value: '1', category: 'REFERRAL', type: 'NUMBER', isPublic: true, description: 'Referral levels supported' },
    // --- Payments (spec #3/#4/#6/#7) ---
    { key: 'payment.cryptoEnabled', value: 'true', category: 'PAYMENT', type: 'BOOLEAN', isPublic: true, description: 'Enable cryptocurrency payments' },
    { key: 'payment.cardToCardEnabled', value: 'true', category: 'PAYMENT', type: 'BOOLEAN', isPublic: true, description: 'Enable card-to-card payments' },
    { key: 'payment.onlineEnabled', value: 'true', category: 'PAYMENT', type: 'BOOLEAN', isPublic: true, description: 'Enable online gateway payments' },
    { key: 'payment.currency', value: 'IRR', category: 'PAYMENT', type: 'STRING', isPublic: true, description: 'Settlement currency' },
    // Fixed wallet-deposit amounts in Toman (spec #7)
    { key: 'wallet.depositAmounts', value: '["50000","100000","200000","500000"]', category: 'WALLET', type: 'JSON', isPublic: true, description: 'Fixed deposit amount buttons (Toman)' },
    // Online gateway (spec #6)
    { key: 'gateway.default.enabled', value: 'false', category: 'GATEWAY', type: 'BOOLEAN', isPublic: false, description: 'Default online gateway enabled' },
    { key: 'gateway.default.merchantId', value: '', category: 'GATEWAY', type: 'STRING', isPublic: false, description: 'Gateway merchant ID' },
    { key: 'gateway.default.apiKey', value: '', category: 'GATEWAY', type: 'STRING', isPublic: false, description: 'Gateway API key' },
    { key: 'gateway.default.secret', value: '', category: 'GATEWAY', type: 'STRING', isPublic: false, description: 'Gateway secret' },
    { key: 'gateway.default.callbackUrl', value: '', category: 'GATEWAY', type: 'STRING', isPublic: true, description: 'Gateway callback URL' },
    { key: 'gateway.default.sandbox', value: 'true', category: 'GATEWAY', type: 'BOOLEAN', isPublic: false, description: 'Sandbox mode' },
    // --- General / brand ---
    { key: 'currency.default', value: 'IRR', category: 'GENERAL', type: 'STRING', isPublic: true },
    { key: 'brand.name', value: 'VPN SaaS', category: 'GENERAL', type: 'STRING', isPublic: true },
    { key: 'brand.supportEmail', value: 'support@vpn-saas.local', category: 'GENERAL', type: 'STRING', isPublic: true },
    { key: 'brand.telegramSupport', value: '', category: 'GENERAL', type: 'STRING', isPublic: true, description: 'Telegram support username' },
  ];
  for (const s of defaultSettings) {
    await prisma.systemSetting.upsert({
      where: { key: s.key },
      update: {},
      create: s,
    });
  }

  // ---------- Sample Plan Category + Plan ----------
  const category = await prisma.planCategory.upsert({
    where: { slug: 'standard' },
    update: {},
    create: { name: 'Standard', slug: 'standard', sortOrder: 1, status: 'ACTIVE' },
  });

  await prisma.plan.upsert({
    where: { slug: 'monthly-50gb' },
    update: {},
    create: {
      categoryId: category.id,
      name: 'Monthly 50GB',
      slug: 'monthly-50gb',
      description: '50GB traffic for 30 days',
      type: 'COMBINATION',
      trafficLimitGb: 50n,
      durationDays: 30,
      deviceLimit: 2,
      serverLimit: 3,
      price: 50000n,
      currency: 'USD',
      priority: 10,
      isVisible: true,
      isRenewable: true,
      status: 'ACTIVE',
    },
  });

  // ---------- Free Trial Plan (so the bot's "Get Trial" flow works) ----------
  // Per spec #1: 500MB traffic (0.5 GB) for 3 days. The bot reads the
  // `trial.trafficLimitGb` SystemSetting (0.5) at runtime for the exact byte
  // budget handed to the Sanity panel; this plan record is the fallback.
  await prisma.plan.upsert({
    where: { slug: 'free-trial' },
    update: {},
    create: {
      categoryId: category.id,
      name: 'Free Trial',
      slug: 'free-trial',
      description: '3-day free trial, 500MB traffic',
      type: 'COMBINATION',
      trafficLimitGb: 1n,
      durationDays: 3,
      deviceLimit: 1,
      serverLimit: 1,
      price: 0n,
      currency: 'IRR',
      priority: 5,
      isVisible: false,
      isEnabled: true,
      isTrial: true,
      isRenewable: false,
      status: 'ACTIVE',
    },
  });

  // ---------- Bank Cards (spec #3) ----------
  // Admin-managed card-to-card deposit cards. Users always see the active card.
  const bankCards = [
    { cardNumber: '6037-9911-2345-6789', cardHolder: 'VPN SaaS Co.', bankName: 'Bank Melli', shebaNumber: 'IR000170000000000000000001', label: 'Primary', isActive: true, isDefault: true, sortOrder: 0 },
    { cardNumber: '5892-1022-3344-5566', cardHolder: 'VPN SaaS Co.', bankName: 'Bank Saderat', shebaNumber: 'IR000190000000000000000002', label: 'Secondary', isActive: true, isDefault: false, sortOrder: 1 },
  ];
  for (const card of bankCards) {
    const existing = await prisma.bankCard.findFirst({
      where: { cardNumber: card.cardNumber },
    });
    if (!existing) {
      await prisma.bankCard.create({ data: card });
    }
  }

  // ---------- Crypto Wallets (spec #4) ----------
  // Admin-managed cryptocurrency deposit addresses. Users always get the latest
  // configured wallet. These are placeholders the admin MUST replace with real
  // addresses before going live.
  const cryptoWallets: Array<{ currency: any; address: string; network: string; label: string; instructions?: string }> = [
    { currency: 'USDT_TRC20', address: 'TXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', network: 'TRC20', label: 'USDT (TRC20)', instructions: 'Send only USDT on the TRC20 (Tron) network.' },
    { currency: 'USDT_ERC20', address: '0xXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', network: 'ERC20', label: 'USDT (ERC20)', instructions: 'Send only USDT on the ERC20 (Ethereum) network.' },
    { currency: 'TON', address: 'EQXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', network: 'TON', label: 'TON', instructions: 'Send only TON to this address.' },
    { currency: 'BTC', address: 'bc1qxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', network: 'Bitcoin', label: 'Bitcoin (BTC)', instructions: 'Send only BTC to this address.' },
    { currency: 'ETH', address: '0xYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY', network: 'Ethereum', label: 'Ethereum (ETH)', instructions: 'Send only ETH to this address.' },
  ];
  for (const wallet of cryptoWallets) {
    const existing = await prisma.cryptoWallet.findFirst({
      where: { currency: wallet.currency, address: wallet.address },
    });
    if (!existing) {
      await prisma.cryptoWallet.create({
        data: {
          currency: wallet.currency,
          address: wallet.address,
          network: wallet.network,
          label: wallet.label,
          instructions: wallet.instructions,
          isActive: wallet.currency === 'USDT_TRC20',
          isDefault: wallet.currency === 'USDT_TRC20',
          sortOrder: wallet.currency === 'USDT_TRC20' ? 0 : 1,
        },
      });
    }
  }

  console.log('✅ Seed completed.');
  console.log(`   Super admin: ${email} / ${password}`);
  console.log(`   Roles: SUPER_ADMIN, ADMIN, OPERATOR, SUPPORT, USER`);
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
