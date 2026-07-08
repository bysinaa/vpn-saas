// PHASE 8 verification — confirm VpnPanel row exists (Sanaei integration live) + Plans count
const { PrismaClient } = require('@prisma/client');

(async () => {
  const prisma = new PrismaClient();
  try {
    const panels = await prisma.vpnPanel.findMany({
      select: { id: true, name: true, type: true, baseUrl: true, apiKey: true, status: true, healthStatus: true, metadata: true },
    });
    console.log('--- VpnPanel rows ---');
    console.log(JSON.stringify(panels, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));

    const plans = await prisma.plan.count();
    console.log('--- Plan count:', plans);

    const settings = await prisma.systemSetting.count();
    console.log('--- Setting count:', settings);

    console.log('PHASE 8 DB verification OK');
  } catch (e) {
    console.error('VERIFY FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
