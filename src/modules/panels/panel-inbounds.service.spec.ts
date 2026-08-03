jest.mock('@/common/prisma/prisma.service', () => ({ PrismaService: class PrismaService {} }));
jest.mock('./panels.service', () => ({ PanelsService: class PanelsService {} }));

import { Logger } from '@nestjs/common';
import { isEligibleXuiInbound, PanelInboundsService } from './panel-inbounds.service';

const remote = (id: number, enabled = true) => ({
  id, remark: `inbound-${id}`, tag: null, protocol: 'vless', port: 443,
  enabled, expiryTime: null, clientCompatible: true,
});

function harness(existing = [{ id: 1n, inboundId: '7', isActive: true, isRemotePresent: true, isProvisionable: true, isExcluded: true, isClientCompatible: true, metadata: { admin: 'keep' } }]) {
  const tx = {
    inboundConfig: {
      findMany: jest.fn().mockResolvedValue(existing),
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    vpnPanel: { update: jest.fn().mockResolvedValue({}) },
  };
  const client = { listInbounds: jest.fn().mockResolvedValue([remote(7), remote(8)]) };
  const prisma = {
    vpnPanel: {
      findUnique: jest.fn().mockResolvedValue({ id: 5n, status: 'ACTIVE', type: 'XUI' }),
      update: jest.fn().mockResolvedValue({}),
    },
    server: { findFirst: jest.fn().mockResolvedValue({ id: 3n }) },
    inboundConfig: { findMany: jest.fn().mockResolvedValue(existing) },
    withTransaction: jest.fn(async (callback: (db: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const panels = {
    getConnection: jest.fn().mockResolvedValue({ id: 5n, type: 'XUI', name: 'local', baseUrl: 'https://xui.test/web', apiKey: '' }),
    getClient: jest.fn().mockReturnValue(client),
  };
  return { client, panels, prisma, service: new PanelInboundsService(prisma as never, panels as never), tx };
}

describe('PanelInboundsService', () => {
  it('upserts safe remote fields, preserves exclusions, and marks missing inbounds unavailable', async () => {
    const h = harness();
    const result = await h.service.syncPanelInbounds('5');

    expect(result).toEqual({ discovered: 2, created: 1, updated: 1, unavailable: 1, excluded: 1, eligible: 1 });
    expect(h.tx.inboundConfig.upsert.mock.calls[0][0].update).toMatchObject({ isActive: true, isRemotePresent: true, isClientCompatible: true });
    expect(h.tx.inboundConfig.upsert.mock.calls[0][0].update).not.toHaveProperty('isExcluded');
    expect(h.tx.inboundConfig.upsert.mock.calls[0][0].update.metadata).not.toHaveProperty('settings');
    expect(h.tx.inboundConfig.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { isRemotePresent: false, isActive: false, isClientCompatible: false },
    }));
  });

  it('leaves the snapshot intact and records a sanitized error after a remote failure', async () => {
    const h = harness();
    h.client.listInbounds.mockRejectedValueOnce(new Error('settings=secret'));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    await expect(h.service.syncPanelInbounds('5')).rejects.toThrow('synchronization failed');

    expect(h.prisma.withTransaction).not.toHaveBeenCalled();
    expect(h.prisma.vpnPanel.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { syncStatus: 'FAILED', lastSyncError: 'Inbound synchronization failed' },
    }));
    expect(warn.mock.calls.flat().join(' ')).not.toContain('secret');
    warn.mockRestore();
  });

  it('leaves the snapshot intact after a malformed remote response', async () => {
    const h = harness();
    h.client.listInbounds.mockRejectedValueOnce(new Error('invalid response payload'));

    await expect(h.service.syncPanelInbounds('5')).rejects.toThrow('synchronization failed');

    expect(h.prisma.withTransaction).not.toHaveBeenCalled();
    expect(h.prisma.vpnPanel.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { syncStatus: 'FAILED', lastSyncError: 'Inbound synchronization failed' },
    }));
  });

  it('uses one in-process sync for concurrent requests to the same panel', async () => {
    const h = harness();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    h.client.listInbounds.mockImplementationOnce(async () => { await pending; return [remote(7)]; });
    const first = h.service.syncPanelInbounds('5');
    const second = h.service.syncPanelInbounds('5');
    release();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(h.client.listInbounds).toHaveBeenCalledTimes(1);
  });

  it('allows independent panels and shares the eligibility predicate', async () => {
    const h = harness();
    await Promise.all([h.service.syncPanelInbounds('5'), h.service.syncPanelInbounds('6')]);
    expect(h.client.listInbounds).toHaveBeenCalledTimes(2);
    expect(isEligibleXuiInbound(true, { inboundId: '7', isActive: true, isRemotePresent: true, isProvisionable: true, isExcluded: false, isClientCompatible: true })).toBe(true);
    expect(isEligibleXuiInbound(true, { inboundId: '7', isActive: true, isRemotePresent: true, isProvisionable: true, isExcluded: true, isClientCompatible: true })).toBe(false);
  });

  it('returns no eligible rows for an inactive panel', async () => {
    const h = harness();
    h.prisma.vpnPanel.findUnique.mockResolvedValueOnce({ id: 5n, status: 'INACTIVE', type: 'XUI' });
    await expect(h.service.eligibleInbounds(5n)).resolves.toEqual([]);
  });

  it('prevents synchronization when no panel server is bound', async () => {
    const h = harness();
    h.prisma.server.findFirst.mockResolvedValueOnce(null);
    await expect(h.service.syncPanelInbounds('5')).rejects.toThrow('no server');
    expect(h.client.listInbounds).not.toHaveBeenCalled();
  });
});
