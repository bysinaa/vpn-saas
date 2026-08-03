jest.mock('@/common/prisma/prisma.service', () => ({ PrismaService: class PrismaService {} }));
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
});
