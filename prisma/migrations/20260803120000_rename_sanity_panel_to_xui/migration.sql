-- Consolidate legacy 3x-ui panel type values under the XUI runtime identifier.
CREATE TYPE "PanelType_new" AS ENUM ('XUI', 'MARZBAN', 'CUSTOM');

ALTER TABLE "vpn_panels" ALTER COLUMN "type" DROP DEFAULT;

ALTER TABLE "vpn_panels"
  ALTER COLUMN "type" TYPE "PanelType_new"
  USING (
    CASE "type"::text
      WHEN 'SANITY' THEN 'XUI'
      WHEN 'X_UI' THEN 'XUI'
      WHEN 'THREE_X_UI' THEN 'XUI'
      ELSE "type"::text
    END
  )::"PanelType_new";

DROP TYPE "PanelType";
ALTER TYPE "PanelType_new" RENAME TO "PanelType";
ALTER TABLE "vpn_panels" ALTER COLUMN "type" SET DEFAULT 'XUI';
