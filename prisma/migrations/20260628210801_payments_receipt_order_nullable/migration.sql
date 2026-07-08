-- AlterTable
ALTER TABLE "payments" ALTER COLUMN "orderId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "receipts" ALTER COLUMN "orderId" DROP NOT NULL;
