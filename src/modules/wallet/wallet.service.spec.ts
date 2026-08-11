jest.mock('@/common/prisma/prisma.service', () => ({ PrismaService: class PrismaService {} }));

import { WalletService } from './wallet.service';

describe('WalletService payment idempotency', () => {
  it('applies one balance mutation for repeated payment settlement', async () => {
    let transaction: any = null;
    const tx: any = {
      wallet: {
        upsert: jest.fn().mockResolvedValue({
          id: 1n,
          balance: 0n,
          giftBalance: 0n,
          totalDeposited: 0n,
          totalSpent: 0n,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ balance: 0n, giftBalance: 0n, totalDeposited: 0n, totalSpent: 0n }]),
      walletTransaction: {
        findUnique: jest.fn(async () => transaction),
        create: jest.fn(async ({ data }: any) => {
          transaction = { id: 2n, createdAt: new Date(), ...data };
          return transaction;
        }),
      },
    };
    const service = new WalletService({} as any);
    const mutation = {
      userId: 3n,
      type: 'DEPOSIT' as const,
      amount: 500n,
      direction: 'credit' as const,
      paymentId: 4n,
    };

    await service.mutateBalanceInTransaction(tx, mutation);
    await service.mutateBalanceInTransaction(tx, mutation);

    expect(tx.walletTransaction.create).toHaveBeenCalledTimes(1);
    expect(tx.wallet.update).toHaveBeenCalledTimes(1);
  });
});
