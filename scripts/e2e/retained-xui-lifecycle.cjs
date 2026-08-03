/* Opt-in local E2E only. Run with TAZAXY_E2E_ALLOW_WRITE=true and --panel-id=2. */
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');

const GIB = 1024n ** 3n;
const panelArg = process.argv.find((arg) => arg.startsWith('--panel-id='));
const panelId = panelArg?.slice('--panel-id='.length);
let stage = 'authorization';
const fail = (message) => { throw new Error(message); };
const local = (host) => ['localhost', '127.0.0.1', '::1'].includes(host.toLowerCase());

async function main() {
  if (process.env.TAZAXY_E2E_ALLOW_WRITE !== 'true') fail('write authorization is required');
  if (!panelId || !/^\d+$/.test(panelId)) fail('a numeric --panel-id is required');

  const prisma = new PrismaClient();
  prisma.withTransaction = (fn) => prisma.$transaction(fn);

  try {
    stage = 'panel-preflight';
    const panel = await prisma.vpnPanel.findUnique({ where: { id: BigInt(panelId) } });
    if (!panel || panel.status !== 'ACTIVE' || panel.type !== 'XUI') fail('selected panel is not enabled XUI');
    const target = new URL(panel.baseUrl);
    if (!local(target.hostname)) fail('selected panel is not loopback');
    // The current app bootstrap requires this legacy setting; its value is derived from the selected DB row.
    process.env.XUI_PANEL_BASE_URL ??= panel.baseUrl;
    const { ProxyHttpService } = require('../../src/common/proxy/proxy-http.service');
    const { XuiPanelClient } = require('../../src/modules/panels/xui-panel.client');
    const { PanelsService } = require('../../src/modules/panels/panels.service');
    const { PanelInboundsService } = require('../../src/modules/panels/panel-inbounds.service');
    const { VpnService } = require('../../src/modules/vpn/vpn.service');
    const { PlansService } = require('../../src/modules/plans/plans.service');
    const { SubscriptionsService } = require('../../src/modules/subscriptions/subscriptions.service');
    const { OrdersService } = require('../../src/modules/orders/orders.service');
    const { WalletService } = require('../../src/modules/wallet/wallet.service');
    const { ServersService } = require('../../src/modules/servers/servers.service');
    const { AuditService } = require('../../src/common/audit/audit.service');
    const proxy = new ProxyHttpService();
    await proxy.onModuleInit();
    const xui = new XuiPanelClient(proxy);
    const panels = new PanelsService(prisma, new Map([['XUI', xui]]));
    const inbounds = new PanelInboundsService(prisma, panels);
    const vpn = new VpnService(prisma, panels, inbounds);
    const plans = new PlansService(prisma, { del: async () => undefined });
    const subscriptions = new SubscriptionsService(prisma, vpn);
    const orders = new OrdersService(prisma, new WalletService(prisma), plans, subscriptions, vpn);
    const servers = new ServersService(prisma, new AuditService(prisma));
    await servers.ensureLocalTestPanelServer({ panelId: panel.id, name: 'TAZAXY Local XUI', host: target.hostname, port: Number(target.port || 443) });
    stage = 'panel-connection';
    const connection = await panels.getConnection(panel.id);
    stage = 'panel-health';
    const health = await xui.health(connection);
    if (!health.reachable) fail('selected local panel is not reachable');
    stage = 'panel-inventory';
    const before = new Set((await xui.listClients(connection)).map((client) => client.email));

    stage = 'inbound-sync';
    const sync = await inbounds.syncPanelInbounds(panelId);
    stage = 'eligible-inbounds';
    const eligible = await inbounds.eligibleInbounds(panel.id);
    if (!eligible.length) fail('no eligible active inbound');
    const inboundIds = eligible.map((inbound) => Number(inbound.inboundId));

    const seed = 20260803;
    const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${seed}`;
    const prefix = `TAZAXY_E2E_${runId}_`;
    const emails = Array.from({ length: 15 }, (_, index) => `${prefix}${String(index + 1).padStart(2, '0')}`);
    stage = 'plan-create';
    const plan = await plans.create({
      name: `TAZAXY_E2E_PLAN_${runId}`, type: 'COMBINATION', trafficLimitGb: 30, durationDays: 35,
      price: '1', currency: 'IRT', panelId, inboundPolicy: 'ALL_ACTIVE', isEnabled: true,
      isVisible: false, priority: -999,
    });

    // Test-only identity injection keeps every real production-flow client inside the deletion-safe prefix.
    let nextEmail = 0;
    vpn.generateClientEmail = () => emails[nextEmail++];
    stage = 'provisioning';
    for (let index = 0; index < emails.length; index += 1) {
      stage = `provisioning-${index + 1}-user`;
      const user = await prisma.user.create({
        data: {
          telegramId: `990${runId.slice(-11)}${String(index).padStart(2, '0')}`,
          username: emails[index], email: `${emails[index].toLowerCase()}@e2e.local`,
          firstName: 'TAZAXY E2E', status: 'ACTIVE', referralCode: `E2E${runId.slice(-10)}${String(index).padStart(2, '0')}`,
        },
      });
      stage = `provisioning-${index + 1}-order`;
      const order = await orders.create({ userId: user.id, planPublicId: plan.publicId, paymentMethod: 'CARD_TO_CARD' });
      stage = `provisioning-${index + 1}-complete`;
      const completed = await orders.completeOrder(BigInt(order.id), user.id);
      stage = `provisioning-${index + 1}-verify`;
      const subscription = await prisma.subscription.findUnique({ where: { id: BigInt(completed.subscription.id) }, include: { vpnUser: true } });
      if (!subscription?.vpnUser || subscription.vpnUser.panelUserId !== emails[index]) fail('production provisioning did not create expected client mapping');
      const remote = await xui.getClient(connection, emails[index]);
      if (!remote || remote.totalGB !== Number(30n * GIB) || remote.expiryTime <= Date.now()) fail('remote client verification failed');
      if ((subscription.provisioningInboundIds ?? []).length !== inboundIds.length) fail('inbound snapshot mismatch');
    }

    stage = 'lifecycle';
    const first = emails[0];
    const full = await xui.getClient(connection, first);
    if (!full) fail('first fixture disappeared');
    await xui.replaceClient(connection, first, { ...full, comment: 'TAZAXY E2E retained fixture' });
    await xui.detachClient(connection, first, [inboundIds[0]]);
    await xui.attachClient(connection, first, [inboundIds[0]]);
    await xui.bulkDisable(connection, emails.slice(0, 2));
    await xui.bulkEnable(connection, emails.slice(0, 2));
    await xui.resetTraffic(connection, first);
    await xui.bulkResetTraffic(connection, emails.slice(0, 2));
    await xui.bulkAdjust(connection, emails.slice(0, 2), 0, 0);
    const group = `TAZAXY_E2E_GROUP_${runId}`;
    await xui.createGroup(connection, group);
    await xui.bulkAddGroup(connection, group, emails);
    await xui.groupEmails(connection, group);
    await xui.renameGroup(connection, group, `${group}_RENAMED`);
    await xui.bulkRemoveGroup(connection, `${group}_RENAMED`, emails.slice(0, 2));
    await xui.deleteGroup(connection, `${group}_RENAMED`);
    await Promise.all([xui.listClients(connection), xui.listClientsPaged(connection, 1, 100), xui.onlines(connection), xui.onlinesByGuid(connection), xui.clientIpsByGuid(connection), xui.activeInbounds(connection), xui.lastOnline(connection), xui.exportClients(connection)]);
    await xui.getClientTraffic(connection, first);
    await xui.clientLinks(connection, first);
    await xui.subscriptionLinks(connection, full.subId || 'missing');
    await xui.getClient(connection, `${prefix}MISSING`);

    const after = new Set((await xui.listClients(connection)).map((client) => client.email));
    const retained = emails.filter((email) => after.has(email));
    if (retained.length !== 15 || [...before].some((email) => !after.has(email))) fail('inventory integrity verification failed');
    console.log(JSON.stringify({ result: 'REAL_E2E_PASS', panelId, sync, eligible: inboundIds.length, runId, seed, clients: emails, retained: retained.length }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => { console.error(JSON.stringify({ result: 'E2E_FAILED', stage })); process.exit(1); });
