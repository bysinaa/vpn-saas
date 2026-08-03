-- Plan-driven XUI provisioning. This migration is intentionally not applied by tests.
CREATE TYPE "InboundPolicy" AS ENUM ('ALL_ACTIVE', 'SELECTED');

ALTER TABLE "plans"
  ADD COLUMN "trafficLimitBytes" BIGINT,
  ADD COLUMN "panelId" BIGINT,
  ADD COLUMN "inboundPolicy" "InboundPolicy" NOT NULL DEFAULT 'ALL_ACTIVE';

UPDATE "plans"
SET "trafficLimitBytes" = "trafficLimitGb" * 1073741824
WHERE "trafficLimitGb" IS NOT NULL;

ALTER TABLE "plans" ALTER COLUMN "currency" SET DEFAULT 'IRT';
ALTER TABLE "plans" ADD CONSTRAINT "plans_panelId_fkey"
  FOREIGN KEY ("panelId") REFERENCES "vpn_panels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "inbound_configs"
  ADD COLUMN "isRemotePresent" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "isProvisionable" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "isExcluded" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "isClientCompatible" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "subscriptions"
  ADD COLUMN "provisioningPanelId" BIGINT,
  ADD COLUMN "provisioningInboundIds" JSONB;

CREATE INDEX "plans_panelId_idx" ON "plans"("panelId");
CREATE INDEX "subscriptions_provisioningPanelId_idx" ON "subscriptions"("provisioningPanelId");
CREATE UNIQUE INDEX "inbound_configs_panelId_inboundId_key" ON "inbound_configs"("panelId", "inboundId");
