ALTER TABLE "vpn_panels"
ADD COLUMN IF NOT EXISTS "subPort" INTEGER DEFAULT 2053,
ADD COLUMN IF NOT EXISTS "subPath" TEXT DEFAULT 'sub';

UPDATE "vpn_panels"
SET
  "subPort" = COALESCE("subPort", 2053),
  "subPath" = COALESCE(NULLIF("subPath", ''), 'sub');

ALTER TABLE "vpn_panels"
ALTER COLUMN "subPort" SET DEFAULT 2053,
ALTER COLUMN "subPath" SET DEFAULT 'sub';