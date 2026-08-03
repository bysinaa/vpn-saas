jest.mock('@/common/prisma/prisma.service', () => ({ PrismaService: class PrismaService {} }));

import { ServersService } from './servers.service';

describe('ServersService local panel binding', () => {
  const input = { panelId: 2n, name: 'TAZAXY Local XUI', host: '127.0.0.1', port: 2053 };

  it('reuses an existing panel binding without creating a duplicate', async () => {
    const prisma = { server: { findFirst: jest.fn().mockResolvedValue({ id: 9n }) } };
    const audit = { log: jest.fn() };
    const service = new ServersService(prisma as never, audit as never);

    await expect(service.ensureLocalTestPanelServer(input)).resolves.toEqual({ id: 9n, created: false });
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('creates one local binding and records a sanitized audit event', async () => {
    const prisma = { server: { findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 9n }) } };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new ServersService(prisma as never, audit as never);

    await expect(service.ensureLocalTestPanelServer(input)).resolves.toEqual({ id: 9n, created: true });
    expect(prisma.server.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ panelId: 2n, metadata: { port: 2053, local: true, test: true } }) }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'CREATE', resource: 'server', after: expect.not.objectContaining({ password: expect.anything() }) }));
  });
});
