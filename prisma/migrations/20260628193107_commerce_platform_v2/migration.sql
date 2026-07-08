/*
  Warnings:

  - Added the required column `updatedAt` to the `vouchers` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'APPROVE';
ALTER TYPE "AuditAction" ADD VALUE 'REJECT';
ALTER TYPE "AuditAction" ADD VALUE 'REDEEM';
ALTER TYPE "AuditAction" ADD VALUE 'ACTIVATE';
ALTER TYPE "AuditAction" ADD VALUE 'VERIFY';
ALTER TYPE "AuditAction" ADD VALUE 'SUSPEND';
ALTER TYPE "AuditAction" ADD VALUE 'RESUME';
ALTER TYPE "AuditAction" ADD VALUE 'REVERSE';

-- AlterTable
ALTER TABLE "plans" ADD COLUMN     "billingUnit" "PlanBillingUnit" NOT NULL DEFAULT 'GB',
ADD COLUMN     "color" TEXT,
ADD COLUMN     "icon" TEXT,
ADD COLUMN     "inboundConfigId" BIGINT,
ADD COLUMN     "isEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "serverGroupId" TEXT,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "vouchers" ADD COLUMN     "batchId" TEXT,
ADD COLUMN     "createdById" BIGINT,
ADD COLUMN     "deviceLimit" INTEGER,
ADD COLUMN     "durationDays" INTEGER,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "serverGroupId" TEXT,
ADD COLUMN     "trafficLimitGb" BIGINT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "usedByIp" TEXT,
ADD COLUMN     "usedByTelegramId" TEXT,
ALTER COLUMN "type" SET DEFAULT 'PLAN';
-- Drop the temporary default; Prisma manages @updatedAt at the client layer.
ALTER TABLE "vouchers" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "bank_cards" (
    "id" BIGSERIAL NOT NULL,
    "publicId" UUID NOT NULL,
    "cardNumber" TEXT NOT NULL,
    "cardHolder" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "shebaNumber" TEXT,
    "label" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdById" BIGINT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crypto_wallets" (
    "id" BIGSERIAL NOT NULL,
    "publicId" UUID NOT NULL,
    "currency" "CryptoCurrency" NOT NULL,
    "label" TEXT,
    "address" TEXT NOT NULL,
    "network" TEXT,
    "instructions" TEXT,
    "qrCodeUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdById" BIGINT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crypto_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bank_cards_publicId_key" ON "bank_cards"("publicId");

-- CreateIndex
CREATE INDEX "bank_cards_isActive_idx" ON "bank_cards"("isActive");

-- CreateIndex
CREATE INDEX "bank_cards_isDefault_idx" ON "bank_cards"("isDefault");

-- CreateIndex
CREATE INDEX "bank_cards_sortOrder_idx" ON "bank_cards"("sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "crypto_wallets_publicId_key" ON "crypto_wallets"("publicId");

-- CreateIndex
CREATE INDEX "crypto_wallets_currency_idx" ON "crypto_wallets"("currency");

-- CreateIndex
CREATE INDEX "crypto_wallets_isActive_idx" ON "crypto_wallets"("isActive");

-- CreateIndex
CREATE INDEX "crypto_wallets_isDefault_idx" ON "crypto_wallets"("isDefault");

-- CreateIndex
CREATE INDEX "crypto_wallets_sortOrder_idx" ON "crypto_wallets"("sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "crypto_wallets_currency_address_key" ON "crypto_wallets"("currency", "address");

-- CreateIndex
CREATE INDEX "plans_isEnabled_idx" ON "plans"("isEnabled");

-- CreateIndex
CREATE INDEX "plans_sortOrder_idx" ON "plans"("sortOrder");

-- CreateIndex
CREATE INDEX "vouchers_planId_idx" ON "vouchers"("planId");

-- CreateIndex
CREATE INDEX "vouchers_batchId_idx" ON "vouchers"("batchId");

-- CreateIndex
CREATE INDEX "vouchers_isActive_idx" ON "vouchers"("isActive");

-- CreateIndex
CREATE INDEX "vouchers_expiresAt_idx" ON "vouchers"("expiresAt");

-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_inboundConfigId_fkey" FOREIGN KEY ("inboundConfigId") REFERENCES "inbound_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
