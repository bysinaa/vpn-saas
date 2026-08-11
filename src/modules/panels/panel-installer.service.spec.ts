jest.mock('@/common/prisma/prisma.service', () => ({ PrismaService: class PrismaService {} }));
jest.mock('./panel-inbounds.service', () => ({
  PanelInboundsService: class PanelInboundsService {},
  isEligibleXuiInbound: (_panelEnabled: boolean, inbound: { isActive: boolean; isRemotePresent: boolean; isProvisionable: boolean; isExcluded: boolean; isClientCompatible: boolean }) =>
    _panelEnabled && inbound.isActive && inbound.isRemotePresent && inbound.isProvisionable && !inbound.isExcluded && inbound.isClientCompatible,
}));
jest.mock('./panels.service', () => ({ PanelsService: class PanelsService {} }));
jest.mock('@/common/utils/crypto.util', () => ({ encrypt: jest.fn(() => 'encrypted') }));

import { encrypt } from '@/common/utils/crypto.util';
import { PanelInstallerService } from './panel-installer.service';

function harness({ eligible = 1, existing = null as { id: bigint } | null } = {}) {
  const panel = { id: 5n, baseUrl: 'https://xui.test/web/', type: 'XUI', subPort: 2096, subPath: 'sub', metadata: null, status: 'ACTIVE', healthStatus: 'HEALTHY', syncStatus: 'SYNCED' };
  const prisma = {
    vpnPanel: {
      findFirst: jest.fn().mockResolvedValue(existing),
      create: jest.fn().mockResolvedValue(panel),
      update: jest.fn().mockResolvedValue(panel),
    },
    server: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 9n }),
      update: jest.fn(),
      count: jest.fn().mockResolvedValue(1),
    },
    inboundConfig: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const inbounds = { syncPanelInbounds: jest.fn().mockResolvedValue({ eligible }) };
  const panels = {
    getConnection: jest.fn().mockResolvedValue({ id: 5n, name: '3X-UI xui.test', type: 'XUI', baseUrl: panel.baseUrl, apiKey: 'admin:secret' }),
    getClient: jest.fn().mockReturnValue({ listInbounds: jest.fn().mockResolvedValue([]) }),
  };
  return { prisma, inbounds, panels, service: new PanelInstallerService(prisma as never, inbounds as never, panels as never) };
}

const input = { baseUrl: 'https://xui.test/web/', username: 'admin', password: 'secret', subPort: 2096, subPath: 'sub' };

describe('PanelInstallerService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates the canonical panel and server, then uses the authenticated inbound synchronizer', async () => {
    const h = harness();
    await expect(h.service.reconcileXui(input)).resolves.toMatchObject({ panelId: '5', synchronization: { eligible: 1 } });

    expect(encrypt).toHaveBeenCalledWith('admin:secret');
    expect(h.prisma.vpnPanel.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ baseUrl: input.baseUrl, subPort: 2096, subPath: 'sub' }) }));
    expect(h.prisma.server.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ panelId: 5n, hostname: 'xui.test' }) }));
    expect(h.inbounds.syncPanelInbounds).toHaveBeenCalledWith('5');
    expect(h.prisma.vpnPanel.update).toHaveBeenLastCalledWith({ where: { id: 5n }, data: { healthStatus: 'HEALTHY' } });
  });

  it('updates the existing canonical records without creating duplicates', async () => {
    const h = harness({ existing: { id: 5n }, eligible: 1 });
    h.prisma.server.findFirst.mockResolvedValue({ id: 9n });
    await h.service.reconcileXui(input);

    expect(h.prisma.vpnPanel.create).not.toHaveBeenCalled();
    expect(h.prisma.server.create).not.toHaveBeenCalled();
    expect(h.prisma.server.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 9n } }));
  });

  it('does not report a healthy runtime without an eligible inbound', async () => {
    const h = harness({ eligible: 0 });
    await expect(h.service.reconcileXui(input)).rejects.toThrow('No eligible XUI inbounds');
    expect(h.prisma.vpnPanel.update).toHaveBeenLastCalledWith({ where: { id: 5n }, data: { healthStatus: 'UNHEALTHY' } });
  });

  it('updates authoritative endpoint drift only after authenticating it, then synchronizes inbounds', async () => {
    const h = harness({ existing: { id: 5n } });
    h.prisma.vpnPanel.findFirst.mockResolvedValue({ id: 5n, baseUrl: 'https://xui.test/web/', subPort: 2096, subPath: 'sub', metadata: null });
    const observation = { baseUrl: 'https://xui.test:2443/new/', subPort: 2097, subPath: 'new-sub', source: '3x-ui-settings', observedAt: '2026-08-10T00:00:00.000Z', listenerCoherent: true };

    await expect(h.service.reconcileXuiDrift(observation)).resolves.toMatchObject({ panelId: '5', changed: true });
    expect(h.panels.getClient().listInbounds).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: observation.baseUrl, subPort: observation.subPort, subPath: observation.subPath }));
    expect(h.prisma.vpnPanel.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ baseUrl: observation.baseUrl, subPort: observation.subPort, subPath: observation.subPath }) }));
    expect(h.inbounds.syncPanelInbounds).toHaveBeenCalledWith('5');
  });

  it('does not change an incoherent listener or overwrite credentials', async () => {
    const h = harness();
    await expect(h.service.reconcileXuiDrift({ baseUrl: 'https://xui.test:2443/', subPort: 2096, subPath: 'sub', source: '3x-ui-settings', observedAt: '2026-08-10T00:00:00.000Z', listenerCoherent: false })).rejects.toThrow('not coherent');
    expect(h.panels.getConnection).not.toHaveBeenCalled();
    expect(encrypt).not.toHaveBeenCalled();
  });

  it('marks failed stored authentication as AUTH_REQUIRED without changing the endpoint', async () => {
    const h = harness();
    h.prisma.vpnPanel.findFirst.mockResolvedValue({ id: 5n, baseUrl: 'https://xui.test/web/', subPort: 2096, subPath: 'sub', metadata: null });
    h.panels.getClient().listInbounds.mockRejectedValue(new Error('3x-ui login rejected'));
    await expect(h.service.reconcileXuiDrift({ baseUrl: 'https://xui.test:2443/', subPort: 2096, subPath: 'sub', source: '3x-ui-settings', observedAt: '2026-08-10T00:00:00.000Z', listenerCoherent: true })).rejects.toThrow('login rejected');
    expect(h.prisma.vpnPanel.update).toHaveBeenCalledWith({ where: { id: 5n }, data: { healthStatus: 'AUTH_REQUIRED' } });
    expect(h.prisma.vpnPanel.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ baseUrl: expect.anything() }) }));
  });

  it('is idempotent when the authoritative endpoint has not changed', async () => {
    const h = harness();
    h.prisma.vpnPanel.findFirst.mockResolvedValue({ id: 5n, baseUrl: input.baseUrl, subPort: input.subPort, subPath: input.subPath, metadata: null });
    const observation = { baseUrl: input.baseUrl, subPort: input.subPort, subPath: input.subPath, source: '3x-ui-settings', observedAt: '2026-08-10T00:00:00.000Z', listenerCoherent: true };

    await expect(h.service.reconcileXuiDrift(observation)).resolves.toMatchObject({ changed: false });
    await expect(h.service.reconcileXuiDrift(observation)).resolves.toMatchObject({ changed: false });
    expect(h.prisma.vpnPanel.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ baseUrl: input.baseUrl }) }));
    expect(h.inbounds.syncPanelInbounds).toHaveBeenCalledTimes(2);
  });

  it('diagnoses CONNECTED only after a read-only authenticated inbound probe', async () => {
    const h = harness();
    h.prisma.vpnPanel.findFirst.mockResolvedValue({
      id: 5n, baseUrl: input.baseUrl, subPort: input.subPort, subPath: input.subPath,
      status: 'ACTIVE', healthStatus: 'HEALTHY', syncStatus: 'SYNCED', metadata: null,
    });
    h.panels.getClient().listInbounds.mockResolvedValue([{ id: 11, enabled: true, clientCompatible: true }]);
    const observation = { baseUrl: input.baseUrl, subPort: input.subPort, subPath: input.subPath, source: '3x-ui-settings', observedAt: '2026-08-10T00:00:00.000Z', listenerCoherent: true };

    await expect(h.service.diagnoseXui(observation)).resolves.toMatchObject({
      state: 'CONNECTED', authentication: 'AUTHENTICATED', apiProbe: true,
      applicationConnectivity: true, inbounds: { discovered: 1, enabled: 1, eligible: 1 },
      reconciliation: { vpnPanel: true, serverCount: 1, inboundConfigCount: 0 },
    });
    expect(h.prisma.vpnPanel.update).not.toHaveBeenCalled();
    expect(h.inbounds.syncPanelInbounds).not.toHaveBeenCalled();
  });

  it('diagnoses invalid stored credentials as AUTH_REQUIRED without writing state', async () => {
    const h = harness();
    h.prisma.vpnPanel.findFirst.mockResolvedValue({
      id: 5n, baseUrl: input.baseUrl, subPort: input.subPort, subPath: input.subPath,
      status: 'ACTIVE', healthStatus: 'HEALTHY', syncStatus: 'SYNCED', metadata: null,
    });
    h.panels.getClient().listInbounds.mockRejectedValue(new Error('3x-ui login rejected'));
    const observation = { baseUrl: input.baseUrl, subPort: input.subPort, subPath: input.subPath, source: '3x-ui-settings', observedAt: '2026-08-10T00:00:00.000Z', listenerCoherent: true };

    await expect(h.service.diagnoseXui(observation)).resolves.toMatchObject({
      state: 'AUTH_REQUIRED', authentication: 'AUTH_REQUIRED', apiProbe: false, applicationConnectivity: false,
    });
    expect(h.prisma.vpnPanel.update).not.toHaveBeenCalled();
  });

  it('diagnoses a freshly discovered endpoint with the stored credential', async () => {
    const h = harness();
    h.prisma.vpnPanel.findFirst.mockResolvedValue({
      id: 5n, baseUrl: input.baseUrl, subPort: input.subPort, subPath: input.subPath,
      metadata: null, status: 'ACTIVE', healthStatus: 'HEALTHY', syncStatus: 'SYNCED',
    });
    h.prisma.server.count.mockResolvedValue(1);
    h.prisma.inboundConfig.findMany.mockResolvedValue([]);
    h.panels.getClient().listInbounds.mockResolvedValue([{ id: 1, enabled: true, clientCompatible: true }]);
    const observation = { baseUrl: 'https://xui.test:8000/api/', subPort: 2097, subPath: 'new-sub', source: '3x-ui-settings', observedAt: '2026-08-12T00:00:00.000Z', listenerCoherent: true };

    await expect(h.service.diagnoseXui(observation)).resolves.toMatchObject({ state: 'CONNECTED', apiProbe: true });
    expect(h.panels.getClient().listInbounds).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: observation.baseUrl, subPort: observation.subPort, subPath: observation.subPath,
    }));
  });
});
