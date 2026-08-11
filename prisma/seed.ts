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
  const email = process.env.SUPER_ADMIN_EMAIL || 'admin@tazaxy.local';
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
    { key: 'trial.dailyGlobalLimit', value: '0', category: 'TRIAL', type: 'NUMBER', description: 'Global daily cap; zero means unlimited' },
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
    { key: 'brand.name', value: 'TAZAXY', category: 'GENERAL', type: 'STRING', isPublic: true },
    { key: 'brand.supportEmail', value: 'support@tazaxy.local', category: 'GENERAL', type: 'STRING', isPublic: true },
    { key: 'brand.telegramSupport', value: '', category: 'GENERAL', type: 'STRING', isPublic: true, description: 'Telegram support username' },
  ];
  for (const s of defaultSettings) {
    await prisma.systemSetting.upsert({
      where: { key: s.key },
      update: {},
      create: s,
    });
  }

  // ---------- Required plan category + trial plan ----------
  const category = await prisma.planCategory.upsert({
    where: { slug: 'standard' },
    update: {},
    create: { name: 'Standard', slug: 'standard', sortOrder: 1, status: 'ACTIVE' },
  });

  // ---------- Free Trial Plan (so the bot's "Get Trial" flow works) ----------
  await prisma.plan.upsert({
    where: { slug: 'free-trial' },
    update: {},
    create: {
      categoryId: category.id,
      name: 'Free Trial',
      slug: 'free-trial',
      description: '3-day free trial, 500MB traffic',
      type: 'COMBINATION',
      trafficLimitBytes: 512n * 1024n * 1024n,
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

  console.log('✅ Seed completed.');
  console.log(`   Super admin: ${email}`);
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
