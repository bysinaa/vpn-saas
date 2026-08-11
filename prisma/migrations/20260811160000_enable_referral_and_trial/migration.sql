INSERT INTO "system_settings" ("key", "value", "category", "type", "isPublic", "editable", "description", "createdAt", "updatedAt")
VALUES
  ('referral.enabled', 'true', 'REFERRAL', 'BOOLEAN', true, true, 'Enable referral rewards', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('referral.referrerReward', '50000', 'REFERRAL', 'NUMBER', true, true, 'Signup reward for the referrer', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('referral.referredReward', '50000', 'REFERRAL', 'NUMBER', true, true, 'Welcome reward for the referred user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('referral.commissionPercent', '10', 'REFERRAL', 'NUMBER', true, true, 'Commission on referred purchases', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('referral.maxBonus', '5000000', 'REFERRAL', 'NUMBER', false, true, 'Maximum referral rewards per user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('trial.enabled', 'true', 'TRIAL', 'BOOLEAN', true, true, 'Enable trial subscriptions', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('trial.perAccountLimit', '1', 'TRIAL', 'NUMBER', false, true, 'Trials allowed per account', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('trial.dailyGlobalLimit', '0', 'TRIAL', 'NUMBER', false, true, 'Zero means no global daily cap', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "plan_categories" ("publicId", "name", "slug", "sortOrder", "status", "createdAt", "updatedAt")
VALUES ('8f09e6d2-8da0-4ff3-84fa-462f83a4c8f1', 'Standard', 'standard', 1, 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "plans" (
  "publicId", "categoryId", "name", "slug", "description", "type", "trafficLimitBytes",
  "durationDays", "deviceLimit", "serverLimit", "price", "currency", "priority", "isVisible",
  "isEnabled", "isTrial", "isRenewable", "status", "createdAt", "updatedAt"
)
SELECT
  '4e911c47-032e-42bf-9637-2caab6d011b1', "id", 'Free Trial', 'free-trial',
  '3-day free trial, 500MB traffic', 'COMBINATION', 536870912, 3, 1, 1, 0, 'IRT', 5,
  false, true, true, false, 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "plan_categories" WHERE "slug" = 'standard'
ON CONFLICT ("slug") DO NOTHING;
