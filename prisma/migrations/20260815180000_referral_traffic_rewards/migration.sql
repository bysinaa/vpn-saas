INSERT INTO "system_settings" ("key", "value", "category", "type", "isPublic", "editable", "description", "createdAt", "updatedAt")
VALUES
  ('referral.rewardTrafficGb', '1', 'REFERRAL', 'NUMBER', true, true, 'Traffic reward in GB for both referral participants', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('referral.rulesText', 'هر کاربر جدید پس از عضویت در کانال‌های اجباری و شروع ربات، برای خودش و معرفش ۱ گیگ هدیه می‌گیرد. هر کاربر فقط یک کلاینت Free Trial دارد و با هر دعوت موفق حجم همان کلاینت بیشتر می‌شود.', 'REFERRAL', 'STRING', true, true, 'Admin-authored Telegram referral rules', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_one_trial_per_user_key"
ON "subscriptions" ("userId")
WHERE "isTrial" = true;

CREATE UNIQUE INDEX IF NOT EXISTS "referral_logs_one_traffic_signup_per_referred_key"
ON "referral_logs" ("referredId")
WHERE "rewardType" = 'TRAFFIC';
