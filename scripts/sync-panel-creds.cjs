/* one-off: sync the VpnPanel DB row's metadata.password with the new 3x-ui
 * admin credentials (admin/admin). SanityPanelClient.login() reads
 * panel.extraConfig.username/password FIRST and only falls back to .env, so
 * the metadata JSON must stay in sync whenever the panel password changes.
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const panel = await prisma.vpnPanel.findFirst({
    where: { type: 'SANITY', baseUrl: 'http://127.0.0.1:2053' },
  });
  if (!panel) {
    console.log('NO_PANEL_FOUND');
    process.exit(1);
  }

  const before = panel.metadata || {};
  console.log('BEFORE:', JSON.stringify(before, null, 2));

  const updated = await prisma.vpnPanel.update({
    where: { id: panel.id },
    data: {
      metadata: {
        ...before,
        username: 'admin',
        password: 'admin',
      },
    },
  });

  console.log('AFTER :', JSON.stringify(updated.metadata, null, 2));
  console.log('SYNCED panel id', String(updated.id));
  await prisma.$disconnect();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
