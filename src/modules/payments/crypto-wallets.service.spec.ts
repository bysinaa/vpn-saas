import { BusinessException } from '@/common/exceptions/business.exception';
jest.mock('@/common/redis/redis.service', () => ({ RedisService: class {} }));
import { CryptoWalletsService } from './crypto-wallets.service';

const wallet = {
  id: 1n,
  publicId: 'wallet-1',
  currency: 'USDT_TRC20',
  address: 'T-address-123',
  network: 'TRC20',
  label: null,
  instructions: null,
  qrCodeUrl: null,
  isActive: true,
  isDefault: false,
  sortOrder: 0,
  createdById: 7n,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function harness() {
  const prisma = {
    cryptoWallet: {
      findUnique: jest.fn().mockResolvedValue(wallet),
      create: jest.fn().mockResolvedValue(wallet),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...wallet, ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      delete: jest.fn().mockResolvedValue(wallet),
    },
  };
  const redis = { del: jest.fn().mockResolvedValue(undefined) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  return { service: new CryptoWalletsService(prisma as any, redis as any, audit as any), prisma, audit };
}

describe('crypto wallet administration', () => {
  it('creates through the canonical model and preserves the DB admin id', async () => {
    const h = harness();
    await h.service.create({ currency: 'USDT_TRC20', address: '  T-address-123  ', network: 'TRC20' }, 7n);
    expect(h.prisma.cryptoWallet.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ currency: 'USDT_TRC20', address: 'T-address-123', createdById: 7n }),
    });
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'CREATE', userId: 7n }));
  });

  it('rejects an empty destination before persistence', async () => {
    const h = harness();
    await expect(h.service.create({ currency: 'TON', address: ' ' }, 7n)).rejects.toBeInstanceOf(BusinessException);
    expect(h.prisma.cryptoWallet.create).not.toHaveBeenCalled();
  });

  it('clears default when disabling and only defaults active wallets', async () => {
    const h = harness();
    await h.service.setActive('wallet-1', false, 7n);
    expect(h.prisma.cryptoWallet.update).toHaveBeenCalledWith({
      where: { publicId: 'wallet-1' },
      data: { isActive: false, isDefault: false },
    });

    h.prisma.cryptoWallet.findUnique.mockResolvedValueOnce({ ...wallet, isActive: false });
    await expect(h.service.setDefault('wallet-1', 7n)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('deletes only after the caller chooses the service remove action', async () => {
    const h = harness();
    await h.service.remove('wallet-1', 7n);
    expect(h.prisma.cryptoWallet.delete).toHaveBeenCalledWith({ where: { publicId: 'wallet-1' } });
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'DELETE', userId: 7n }));
  });
});
