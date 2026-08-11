jest.mock('@/common/prisma/prisma.service', () => ({ PrismaService: class PrismaService {} }));
jest.mock('../panels/panels.service', () => ({ PanelsService: class PanelsService {} }));

import { Logger } from '@nestjs/common';
import { VpnService } from './vpn.service';

const GB = 1024n * 1024n * 1024n;

function harness(options: { username?: string | null; inbounds?: string[] } = {}) {
  const subscription = {
    id: 9n,
    userId: 3n,
    status: 'ACTIVE',
    trafficLimitBytes: 30n * GB,
    expiresAt: new Date('2030-02-05T00:00:00.000Z'),
    deviceLimit: 2,
    provisioningPanelId: null as bigint | null,
    provisioningInboundIds: null as number[] | null,
    plan: { panelId: 5n, inboundPolicy: 'ALL_ACTIVE' as const },
    user: {
      telegramId: '123456',
      username: options.username === undefined ? 'John.Doe' : options.username,
    },
  };
  let mapping: any = null;
  let remoteUser: any = null;
  let remoteCreates = 0;
  const subscriptionUpdates: Array<Record<string, unknown>> = [];
  const mappingWrites: Array<Record<string, unknown>> = [];
  const client = {
    getUser: jest.fn(async () => remoteUser),
    createUser: jest.fn(async (_connection: any, input: any) => {
      if (remoteUser) throw new Error('duplicate client');
      remoteCreates += 1;
      remoteUser = {
        username: input.username,
        status: 'active',
        dataLimitBytes: input.dataLimitBytes?.toString() ?? null,
        expiryMs: input.expireMs,
        subLink: '',
      };
      return remoteUser;
    }),
    updateUser: jest.fn(async (_connection: any, username: string, input: any) => {
      remoteUser = { ...remoteUser, ...input, username };
      return remoteUser;
    }),
    attachClient: jest.fn().mockResolvedValue(undefined),
    clientLinks: jest.fn().mockResolvedValue(['protocol://redacted']),
    subscriptionLinks: jest.fn().mockResolvedValue(['subscription://redacted']),
  };
  const prisma = {
    subscription: {
      findUnique: jest.fn().mockResolvedValue(subscription),
      update: jest.fn(async ({ data }: any) => {
        subscriptionUpdates.push(data);
        Object.assign(subscription, data);
        return subscription;
      }),
    },
    vpnPanel: { findFirst: jest.fn().mockResolvedValue({ id: 5n, type: 'XUI' }) },
    vpnUser: {
      findUnique: jest.fn(async () => mapping),
      upsert: jest.fn(async ({ create, update }: any) => {
        mapping = mapping ? { ...mapping, ...update } : { id: 8n, ...create };
        mappingWrites.push({ ...mapping });
        return mapping;
      }),
    },
  };
  const panels = {
    getConnection: jest.fn().mockResolvedValue({
      id: 5n,
      name: 'local',
      type: 'XUI',
      baseUrl: 'https://panel.test/web',
      apiKey: '',
      subPort: 8443,
      subPath: '/custom/sub/',
    }),
    getClient: jest.fn().mockReturnValue(client),
  };
  const inboundRows = (options.inbounds ?? ['12', '11', '12']).map((inboundId) => ({
    inboundId,
    isActive: true,
    isRemotePresent: true,
    isProvisionable: true,
    isExcluded: false,
    isClientCompatible: true,
  }));
  const inboundSelector = { eligibleInbounds: jest.fn().mockResolvedValue(inboundRows) };
  const service = new VpnService(prisma as never, panels as never, inboundSelector as never);

  return {
    client,
    inboundSelector,
    mapping: () => mapping,
    mappingWrites,
    panels,
    prisma,
    remoteUser: () => remoteUser,
    remoteCreates: () => remoteCreates,
    service,
    subscription,
    subscriptionUpdates,
  };
}

describe('VpnService first-class XUI provisioning', () => {
  it('maps one plan-driven client to exact inbounds with shared 30 GB quota', async () => {
    const h = harness();

    const result = await h.service.createVpnUserForSubscription(9n);

    expect(h.client.createUser).toHaveBeenCalledTimes(1);
    expect(h.client.createUser.mock.calls[0][1]).toMatchObject({
      username: 'tg_john_doe_123456',
      telegramId: '123456',
      inboundIds: [11, 12],
      dataLimitBytes: 30n * GB,
      expireMs: new Date('2030-02-05T00:00:00.000Z').getTime(),
      deviceLimit: 2,
    });
    expect(h.subscriptionUpdates[0]).toEqual({
      provisioningPanelId: 5n,
      provisioningInboundIds: [11, 12],
    });
    expect(h.mapping()).toMatchObject({
      panelUserId: 'tg_john_doe_123456',
      totalTrafficBytes: 30n * GB,
      status: 'ACTIVE',
      syncError: null,
      metadata: {
        telegramId: '123456',
        telegramUsername: 'John.Doe',
        inboundIds: [11, 12],
      },
    });
    expect(result?.subscriptionUrl).toMatch(
      /^https:\/\/panel\.test:8443\/custom\/sub\/[0-9a-f-]+$/,
    );
  });

  it('uses the Telegram ID fallback when username is absent', async () => {
    const h = harness({ username: null });
    await h.service.createVpnUserForSubscription(9n);
    expect(h.client.createUser.mock.calls[0][1].username).toBe('tg_123456');
  });

  it('reuses persisted identity and updates instead of duplicating on retry', async () => {
    const h = harness();
    await h.service.createVpnUserForSubscription(9n);
    const firstToken = h.mapping().subToken;

    await h.service.createVpnUserForSubscription(9n);

    expect(h.client.createUser).toHaveBeenCalledTimes(1);
    expect(h.client.updateUser).toHaveBeenCalledWith(
      expect.anything(),
      'tg_john_doe_123456',
      expect.objectContaining({
        dataLimitBytes: 30n * GB,
        deviceLimit: 2,
        subId: firstToken,
        telegramId: '123456',
      }),
    );
    expect(h.client.attachClient).toHaveBeenCalledWith(
      expect.anything(),
      'tg_john_doe_123456',
      [11, 12],
    );
    expect(h.mapping().subToken).toBe(firstToken);
  });

  it('uses a stable subscription suffix when the user already owns the base XUI identity', async () => {
    const h = harness();
    (h.prisma.vpnUser.findUnique as jest.Mock).mockImplementation(async ({ where }: any) =>
      where.panelUserId === 'tg_john_doe_123456' ? { subscriptionId: 2n } : null,
    );

    await h.service.createVpnUserForSubscription(9n);

    expect(h.client.createUser.mock.calls[0][1].username).toBe('tg_john_doe_123456_s9');
    expect(h.mapping()).toMatchObject({
      panelUserId: 'tg_john_doe_123456_s9',
      subscriptionId: 9n,
    });
  });

  it('keeps one logical remote client under simultaneous first attempts', async () => {
    const h = harness();

    const [first, second] = await Promise.all([
      h.service.createVpnUserForSubscription(9n),
      h.service.createVpnUserForSubscription(9n),
    ]);

    expect(h.remoteCreates()).toBe(1);
    expect(h.mapping().panelUserId).toBe('tg_john_doe_123456');
    expect(first?.subscriptionUrl).toBe(second?.subscriptionUrl);
  });

  it('reconciles an ambiguous create without creating a duplicate', async () => {
    const h = harness();
    h.client.createUser.mockImplementationOnce(async (_connection: any, input: any) => {
      (h.client.getUser as jest.Mock).mockResolvedValue({ username: input.username });
      throw new Error('request timeout');
    });

    await h.service.createVpnUserForSubscription(9n);

    expect(h.client.createUser).toHaveBeenCalledTimes(1);
    expect(h.client.getUser).toHaveBeenCalledTimes(2);
  });

  it('persists a safe recoverable failure and reuses its identity on retry', async () => {
    const h = harness();
    h.client.getUser.mockRejectedValueOnce(new Error('secret-token-in-error'));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    await expect(h.service.createVpnUserForSubscription(9n)).rejects.toThrow(
      'VPN provisioning is pending and can be retried',
    );
    const failed = { ...h.mapping() };
    expect(failed).toMatchObject({
      panelUserId: 'tg_john_doe_123456',
      status: 'DISABLED',
      syncError: 'XUI provisioning failed; retry is safe',
    });
    expect(warn.mock.calls.flat().join(' ')).not.toContain('secret-token-in-error');

    await h.service.createVpnUserForSubscription(9n);
    expect(h.mapping()).toMatchObject({
      panelUserId: failed.panelUserId,
      subToken: failed.subToken,
      status: 'ACTIVE',
      syncError: null,
    });
    warn.mockRestore();
  });

  it('fails before panel creation when no eligible inbound exists', async () => {
    const h = harness({ inbounds: [] });
    await expect(h.service.createVpnUserForSubscription(9n)).rejects.toThrow(
      'No eligible active XUI inbound',
    );
    expect(h.client.createUser).not.toHaveBeenCalled();
  });

  it('does not log subscription links, protocol links, or sub tokens', async () => {
    const h = harness();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    await h.service.createVpnUserForSubscription(9n);
    const output = log.mock.calls.flat().join(' ');
    expect(output).not.toMatch(/subscription:\/\/redacted|protocol:\/\/redacted/);
    expect(output).not.toContain(h.mapping().subToken);
    log.mockRestore();
  });
});

function runtimeHarness(initialStatus: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
  let vpnUser: any = {
    id: 8n,
    panelId: 5n,
    panelUserId: 'tg_john_123456',
    subscriptionId: 9n,
    status: initialStatus === 'ACTIVE' ? 'ACTIVE' : 'DISABLED',
    usedTrafficBytes: 1024n,
    syncError: null,
  };
  const subscription = {
    id: 9n,
    status: initialStatus,
    usedTrafficBytes: 1024n,
    pausedAt: null,
    subscriptionLink: 'https://panel.test/sub/redacted',
  };
  const events: string[] = [];
  let remoteUser: any = { username: vpnUser.panelUserId, status: 'active' };
  const client = {
    getUser: jest.fn(async () => remoteUser),
    updateUser: jest.fn(async (_connection: any, username: string, input: any) => {
      remoteUser = { ...remoteUser, ...input, username };
      return remoteUser;
    }),
    resetTraffic: jest.fn().mockResolvedValue(undefined),
    deleteUser: jest.fn(async () => {
      remoteUser = null;
    }),
  };
  const prisma: any = {
    vpnUser: {
      findUnique: jest.fn(async () => vpnUser),
      update: jest.fn(async ({ data }: any) => {
        if (!vpnUser) throw new Error('missing mapping');
        vpnUser = { ...vpnUser, ...data };
        return vpnUser;
      }),
      delete: jest.fn(async () => {
        const deleted = vpnUser;
        vpnUser = null;
        return deleted;
      }),
    },
    subscription: {
      update: jest.fn(async ({ data }: any) => {
        Object.assign(subscription, data);
        return subscription;
      }),
    },
    subscriptionEvent: {
      create: jest.fn(async ({ data }: any) => {
        events.push(data.event);
        return data;
      }),
    },
  };
  prisma.withTransaction = jest.fn((fn: (tx: any) => Promise<unknown>) => fn(prisma));
  const panels = {
    getConnection: jest.fn().mockResolvedValue({
      id: 5n,
      name: 'local',
      type: 'XUI',
      baseUrl: 'https://panel.test',
      apiKey: '',
    }),
    getClient: jest.fn().mockReturnValue(client),
  };
  const service = new VpnService(prisma, panels as never, {} as never);
  return {
    client,
    events,
    prisma,
    remoteUser: () => remoteUser,
    service,
    subscription,
    vpnUser: () => vpnUser,
  };
}

describe('VpnService real XUI runtime operations', () => {
  it('disables XUI before persisting a suspended subscription', async () => {
    const h = runtimeHarness();

    await h.service.suspendVpnUser(9n);

    expect(h.client.updateUser).toHaveBeenCalledWith(expect.anything(), 'tg_john_123456', {
      status: 'disabled',
    });
    expect(h.vpnUser()).toMatchObject({ status: 'DISABLED', syncError: null });
    expect(h.subscription.status).toBe('SUSPENDED');
    expect(h.events).toEqual(['SUSPENDED']);
  });

  it('enables XUI before persisting an active subscription', async () => {
    const h = runtimeHarness('SUSPENDED');

    await h.service.resumeVpnUser(9n);

    expect(h.client.updateUser).toHaveBeenCalledWith(expect.anything(), 'tg_john_123456', {
      status: 'active',
    });
    expect(h.vpnUser()).toMatchObject({ status: 'ACTIVE', syncError: null });
    expect(h.subscription.status).toBe('ACTIVE');
    expect(h.events).toEqual(['RESUMED']);
  });

  it('resets XUI traffic before reconciling both local counters', async () => {
    const h = runtimeHarness();

    await h.service.resetTraffic(9n);

    expect(h.client.resetTraffic).toHaveBeenCalledWith(expect.anything(), 'tg_john_123456');
    expect(h.vpnUser().usedTrafficBytes).toBe(0n);
    expect(h.subscription.usedTrafficBytes).toBe(0n);
    expect(h.events).toEqual(['RESET']);
  });

  it.each([
    ['suspend', (h: ReturnType<typeof runtimeHarness>) => h.service.suspendVpnUser(9n)],
    ['resume', (h: ReturnType<typeof runtimeHarness>) => h.service.resumeVpnUser(9n)],
    ['traffic reset', (h: ReturnType<typeof runtimeHarness>) => h.service.resetTraffic(9n)],
  ])('does not change local state when XUI %s fails', async (operation, run) => {
    const h = runtimeHarness();
    const remote = operation === 'traffic reset' ? h.client.resetTraffic : h.client.updateUser;
    remote.mockRejectedValueOnce(new Error('secret-panel-credential'));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    await expect(run(h)).rejects.toThrow('can be retried');

    expect(h.subscription).toMatchObject({ status: 'ACTIVE', usedTrafficBytes: 1024n });
    expect(h.vpnUser().syncError).toMatch(/retry is safe/);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('secret-panel-credential');
    warn.mockRestore();
  });

  it('deletes an existing XUI client before cancelling local state', async () => {
    const h = runtimeHarness();

    await h.service.deleteVpnUser(8n);

    expect(h.client.deleteUser).toHaveBeenCalledWith(expect.anything(), 'tg_john_123456');
    expect(h.vpnUser()).toBeNull();
    expect(h.subscription.status).toBe('CANCELLED');
    expect(h.subscription.subscriptionLink).toBeNull();
    expect(h.events).toEqual(['CANCELLED']);
  });

  it('treats an already absent XUI client as an idempotent delete', async () => {
    const h = runtimeHarness();
    h.client.getUser.mockResolvedValue(null);

    await h.service.deleteVpnUser(8n);

    expect(h.client.deleteUser).not.toHaveBeenCalled();
    expect(h.vpnUser()).toBeNull();
    expect(h.subscription.status).toBe('CANCELLED');
  });

  it('keeps deletion retryable when XUI still has the client after failure', async () => {
    const h = runtimeHarness();
    h.client.deleteUser.mockRejectedValueOnce(new Error('secret-delete-error'));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    await expect(h.service.deleteVpnUser(8n)).rejects.toThrow('can be retried');

    expect(h.vpnUser()).not.toBeNull();
    expect(h.subscription.status).toBe('ACTIVE');
    expect(h.vpnUser().syncError).toMatch(/retry is safe/);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('secret-delete-error');
    warn.mockRestore();
  });
});
