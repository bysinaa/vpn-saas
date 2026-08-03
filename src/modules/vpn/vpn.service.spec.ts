jest.mock('@/common/prisma/prisma.service', () => ({ PrismaService: class PrismaService {} }));
jest.mock('../panels/panels.service', () => ({ PanelsService: class PanelsService {} }));

import { Logger } from '@nestjs/common';
import { VpnService } from './vpn.service';

const GB = 1024n * 1024n * 1024n;

function harness(inbounds = [
  { inboundId: '11', isActive: true, isRemotePresent: true, isProvisionable: true, isExcluded: false, isClientCompatible: true },
  { inboundId: '12', isActive: true, isRemotePresent: true, isProvisionable: true, isExcluded: false, isClientCompatible: true },
]) {
  const subscription = {
    id: 9n,
    userId: 3n,
    trafficLimitBytes: 30n * GB,
    expiresAt: new Date('2030-02-05T00:00:00.000Z'),
    deviceLimit: 1,
    provisioningPanelId: null,
    provisioningInboundIds: null,
    plan: { panelId: 5n, inboundPolicy: 'ALL_ACTIVE' },
    user: { telegramId: '123' },
  };
  const updates: Array<Record<string, unknown>> = [];
  const client = {
    createUser: jest.fn().mockResolvedValue({ username: 'created' }),
    getUser: jest.fn().mockResolvedValue(null),
    clientLinks: jest.fn().mockResolvedValue({ links: ['protocol://redacted'] }),
    subscriptionLinks: jest.fn().mockResolvedValue({ links: ['subscription://redacted'] }),
  };
  const prisma = {
    subscription: {
      findUnique: jest.fn().mockResolvedValue(subscription),
      update: jest.fn().mockImplementation(async ({ data }) => { updates.push(data); return {}; }),
    },
    vpnPanel: {
      findFirst: jest
        .fn()
        .mockResolvedValueOnce({ id: 5n })
        .mockResolvedValue({ id: 5n, type: 'XUI' }),
    },
    vpnUser: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) },
  };
  const panels = {
    getConnection: jest.fn().mockResolvedValue({ id: 5n, name: 'local', type: 'XUI', baseUrl: 'https://panel.test', apiKey: '', subPort: 443, subPath: 'sub' }),
    getClient: jest.fn().mockReturnValue(client),
  };
  const inboundSelector = { eligibleInbounds: jest.fn().mockResolvedValue(inbounds) };
  return { client, inboundSelector, inbounds, panels, prisma, service: new VpnService(prisma as never, panels as never, inboundSelector as never), updates };
}

describe('VpnService first-class XUI provisioning', () => {
  it('attaches one 30 GB client to every eligible inbound without multiplying the quota', async () => {
    const h = harness([
      { inboundId: '11', isActive: true, isRemotePresent: true, isProvisionable: true, isExcluded: false, isClientCompatible: true },
      { inboundId: '12', isActive: true, isRemotePresent: true, isProvisionable: true, isExcluded: false, isClientCompatible: true },
    ]);

    const result = await h.service.createVpnUserForSubscription(9n);

    expect(h.client.createUser).toHaveBeenCalledTimes(1);
    expect(h.client.createUser.mock.calls[0][1]).toMatchObject({
      inboundIds: [11, 12], dataLimitBytes: 30n * GB, expireMs: new Date('2030-02-05T00:00:00.000Z').getTime(),
    });
    expect(h.client.createUser.mock.calls[0][1].subId).toEqual(expect.any(String));
    expect(h.inboundSelector.eligibleInbounds).toHaveBeenCalledWith(5n, expect.anything());
    expect(h.updates[0]).toEqual({ provisioningPanelId: 5n, provisioningInboundIds: [11, 12] });
    expect(result?.subscriptionUrl).toMatch(/^https:\/\/panel\.test\/sub\//);
  });

  it('fails before panel creation when no eligible inbound exists', async () => {
    const h = harness([]);

    await expect(h.service.createVpnUserForSubscription(9n)).rejects.toThrow('No eligible active XUI inbound');
    expect(h.client.createUser).not.toHaveBeenCalled();
  });

  it('reconciles an ambiguous create before retrying only when the client is absent', async () => {
    const h = harness();
    h.client.createUser
      .mockRejectedValueOnce(new Error('request timeout'))
      .mockResolvedValueOnce({ username: 'created' });

    await h.service.createVpnUserForSubscription(9n);

    expect(h.client.getUser).toHaveBeenCalledTimes(1);
    expect(h.client.createUser).toHaveBeenCalledTimes(2);
  });

  it('does not log subscription links or protocol links', async () => {
    const h = harness();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();

    await h.service.createVpnUserForSubscription(9n);

    expect(log.mock.calls.flat().join(' ')).not.toContain('subscription://redacted');
    expect(log.mock.calls.flat().join(' ')).not.toContain('protocol://redacted');
    log.mockRestore();
  });
});
