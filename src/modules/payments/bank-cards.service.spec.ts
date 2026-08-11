import { BusinessException } from '@/common/exceptions/business.exception';
jest.mock('@/common/redis/redis.service', () => ({ RedisService: class {} }));
import { isValidCardNumber, maskCardNumber, normalizeCardNumber, BankCardsService } from './bank-cards.service';

describe('bank card administration', () => {
  it('normalizes and validates card numbers', () => {
    expect(normalizeCardNumber('6037-9900 0000 0006')).toBe('6037990000000006');
    expect(isValidCardNumber('6037990000000006')).toBe(true);
    expect(isValidCardNumber('1234')).toBe(false);
    expect(maskCardNumber('6037990000000006')).toBe('••••••••••••0006');
  });

  it('rejects invalid cards before persistence', async () => {
    const prisma = { bankCard: { create: jest.fn() } } as any;
    const service = new BankCardsService(prisma, {} as any, { log: jest.fn() } as any);
    await expect(service.create({ cardNumber: '1234', cardHolder: 'A', bankName: 'B' })).rejects.toBeInstanceOf(BusinessException);
    expect(prisma.bankCard.create).not.toHaveBeenCalled();
  });

  it('soft-disables cards instead of deleting referenced history', async () => {
    const existing = { id: 1n, publicId: 'card-1', isActive: true, isDefault: true, cardNumber: '6037990000000006', cardHolder: 'Admin', bankName: 'Bank', sortOrder: 0, createdById: null, createdAt: new Date(), updatedAt: new Date() };
    const prisma = { bankCard: { findUnique: jest.fn().mockResolvedValue(existing), update: jest.fn().mockResolvedValue({ ...existing, isActive: false, isDefault: false }) } } as any;
    const service = new BankCardsService(prisma, { del: jest.fn() } as any, { log: jest.fn() } as any);
    await service.remove('card-1', 1n);
    expect(prisma.bankCard.update).toHaveBeenCalledWith({ where: { publicId: 'card-1' }, data: { isActive: false, isDefault: false } });
  });
});
