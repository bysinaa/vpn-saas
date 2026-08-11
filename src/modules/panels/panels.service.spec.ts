jest.mock('@/common/prisma/prisma.service', () => ({ PrismaService: class PrismaService {} }));
jest.mock('@/config', () => ({ config: { xui: { subPort: 9443, subPath: 'configured-sub' } } }));
jest.mock('@/common/utils/crypto.util', () => ({
  encrypt: jest.fn(),
  decrypt: jest.fn(),
}));

import { PanelsService } from './panels.service';

describe('PanelsService client resolution', () => {
  it('resolves XUI and does not retain the SANITY resolver key', () => {
    const xui = { type: 'XUI' } as any;
    const panels = new PanelsService({} as any, new Map([['XUI', xui]]));

    expect(panels.getClient('XUI')).toBe(xui);
    expect(() => panels.getClient('SANITY')).toThrow("No panel client for type 'SANITY'");
  });

  it('uses configured subscription port and path when the panel row omits them', async () => {
    const prisma = {
      vpnPanel: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1n,
          name: 'XUI',
          type: 'XUI',
          baseUrl: 'https://panel.test',
          apiKey: '',
          subPort: null,
          subPath: null,
          status: 'ACTIVE',
          metadata: null,
        }),
      },
    };
    const panels = new PanelsService(prisma as any, new Map());

    await expect(panels.getConnection(1n)).resolves.toMatchObject({
      subPort: 9443,
      subPath: 'configured-sub',
    });
  });
});
