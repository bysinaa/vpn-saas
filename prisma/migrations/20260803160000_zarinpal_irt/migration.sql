ALTER TABLE "payments"
  ADD COLUMN "gatewayStatus" TEXT,
  ADD COLUMN "gatewayVerifyCode" INTEGER,
  ADD COLUMN "gatewayRefId" TEXT;
