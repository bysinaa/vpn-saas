/* one-off: promote Telegram user 760573094 to SUPER_ADMIN so the admin menu shows immediately */
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const u = await p.user.findUnique({
    where: { telegramId: '760573094' },
    select: { id: true, publicId: true, role: true, firstName: true },
  });
  if (!u) {
    console.log('USER_NOT_FOUND — will be created as SUPER_ADMIN on next /start via mintForTelegramUser fix');
    process.exit(0);
  }
  console.log('BEFORE:', JSON.stringify({ id: String(u.id), publicId: u.publicId, role: u.role, firstName: u.firstName }));
  if (u.role === 'USER') {
    const up = await p.user.update({ where: { id: u.id }, data: { role: 'SUPER_ADMIN' }, select: { role: true } });
    console.log('PROMOTED_TO:', up.role);
  } else {
    console.log('ALREADY_ADMIN:', u.role);
  }
  await p.$disconnect();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
