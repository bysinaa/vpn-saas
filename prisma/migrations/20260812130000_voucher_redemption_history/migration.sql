CREATE TABLE "voucher_redemptions" (
    "id" BIGSERIAL NOT NULL,
    "publicId" UUID NOT NULL,
    "voucherId" BIGINT NOT NULL,
    "userId" BIGINT NOT NULL,
    "subscriptionId" BIGINT NOT NULL,
    "telegramId" TEXT,
    "ipAddress" TEXT,
    "metadata" JSONB,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voucher_redemptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "voucher_redemptions_publicId_key" ON "voucher_redemptions"("publicId");
CREATE UNIQUE INDEX "voucher_redemptions_subscriptionId_key" ON "voucher_redemptions"("subscriptionId");
CREATE UNIQUE INDEX "voucher_redemptions_voucherId_userId_key" ON "voucher_redemptions"("voucherId", "userId");
CREATE INDEX "voucher_redemptions_userId_idx" ON "voucher_redemptions"("userId");
CREATE INDEX "voucher_redemptions_redeemedAt_idx" ON "voucher_redemptions"("redeemedAt");

ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_voucherId_fkey"
FOREIGN KEY ("voucherId") REFERENCES "vouchers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_subscriptionId_fkey"
FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
