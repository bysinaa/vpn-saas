# Telegram Admin State

Persistent working memory for this execution plan. Keep concise.

## Current phase
Phase 4 — COMPLETE (2026-08-10)

Telegram Admin UX / Payment Methods execution plan complete.

## Executable callback graph
- Entry: main-menu `admin` -> `AdminFlow.show`; `adm:dash` -> `showDashboard`.
- Sections: `adm:(?!dash)(.+)` -> `showSection`; every concrete section view calls `guard()`. Dashboard separately accepts the configured super-admin Telegram ID or a DB user with `SUPER_ADMIN`, `ADMIN`, or `OPERATOR` role.
- Bank cards: `adm:cards` -> list/detail/add/edit/toggle/default/confirmed safe remove -> canonical `BankCardsService`. Admin audit IDs use the session DB user ID. Card and sheba values are masked after entry; removal retains history by clearing active/default. Purchase and wallet deposit flows use `getDepositCard()` (active/default semantics), and payment creation now refuses an unavailable destination before inserting a payment.
- Crypto: `adm:crypto` -> list/detail/currency selection/add/edit/toggle/default/confirmed remove -> canonical `CryptoWalletsService`. The service now exposes `findOne`, `setActive`, and `setDefault`, validates addresses, and keeps cache/audit behavior centralized. `PaymentsService` resolves `getDefault(currency)` before payment creation, persists that address into `CryptoPayment`, and returns address/network to the Telegram checkout; legacy `payment.crypto.*.address` reads were removed.
- Gateway: `adm:gateway` manages the existing Zarinpal provider through canonical `SettingsService` keys `gateway.default.enabled`, `merchantId`, `callbackUrl`, and `sandbox`. Merchant/callback plaintext is not rendered after entry, and the generic settings list/editor masks gateway and secret-like values. `DefaultZarinpalGateway` consumes enabled/merchant/sandbox settings with environment fallback; `PaymentsService` consumes callback URL and blocks disabled gateways before payment creation. Existing verification remains allowed after disable. Seeded but runtime-inert API key/secret fields are deliberately not exposed in the dedicated gateway UI.
- Settings: `adm:settings` -> `SettingsService.listAll`; `aset:edit|toggle|delete|new` -> `SettingsService`. It overlaps the dedicated trial/gateway display sections.
- Receipt decisions: `payapprove:<paymentPublicId>` / `payreject:<paymentPublicId>` -> `AdminFlow` -> canonical `PaymentsService.verifyReceipt` using the receipt public ID and session DB admin ID.
- Other dashboard entries currently route to real read views or wizards: users, payments, wallet, plans, vouchers, referrals, trial, broadcast, tickets, education, statistics, logs, and roles.

## Phase 3 final menu
- Dashboard; Users / Payments.
- Bank cards / Crypto; Payment gateway / Wallet.
- Plans / Vouchers; Referrals / Trial.
- Broadcast / Tickets; Education / Settings.
- Statistics / Logs; Roles; Home.
- Bank cards, crypto destinations, and gateway configuration are adjacent at the top of the menu.

## Phase 3 cleanup
- Removed top-level `adm:servers` and `adm:panels` buttons and section routing.
- Removed Telegram-only server inventory, panel list/detail/health/toggle/create UI, `apnl:*` registration/handlers, panel wizard state/data/menu branches, and `PanelsService` injection into `AdminFlow`.
- Removed dead exported `adminDashboardKeyboard`, its unused action constants, and unused server/panel translation keys. This eliminates the incorrect user-facing `پنل‌های سنتی` label; no backend identifier was renamed.
- Added a dashboard menu regression test proving payment grouping and absence of redundant callbacks.

## Backend safety audit
- Preserve `VpnPanel`, `Server`, and `InboundConfig` models, migrations, modules, services, and controllers.
- `PanelInstallerService` reconciles detected XUI state into `VpnPanel` + `Server` and invokes `PanelInboundsService`; CLI `panel status/diagnose` and `src/scripts/reconcile-xui.ts` use that path.
- `PanelInboundsService` requires the panel's `Server`, synchronizes `InboundConfig`, and supplies eligible inbounds.
- `VpnService` selects an active XUI panel plus eligible inbounds, persists subscription provisioning targets, creates/updates/deletes panel users, reconciles inbound attachment, reads usage, resets traffic, and builds subscription links.
- Plans reference `VpnPanel`/`InboundConfig`; subscriptions persist provisioning panel/inbound IDs; `VpnUser` and `SubscriptionServer` retain panel/server relations.
- `ServersService`/`ServersController` and `PanelsService`/`PanelsController` remain executable REST admin surfaces. Trial availability and admin dashboard stats also query `Server`.
- Prisma relations/migrations enforce panel-server-inbound-plan-user/subscription links, and installer/inbound/VPN/plan/server/subscription tests exercise them.

## admin.flow.spec.ts result
- Root cause: the old spec asserted a second receipt transaction, wallet credit, order completion, and VPN provisioning inside `AdminFlow`. That behavior duplicated the canonical settlement path and its mocks became stale when AdminFlow's dependency changed from `OrdersService` to `PaymentsService`.
- Correct fix: AdminFlow now only resolves payment -> receipt and delegates APPROVED/REJECTED decisions to `PaymentsService.verifyReceipt`. The spec mocks the real DI dependency and asserts receipt-public-ID, session DB admin ID, both decisions, and repeated-approval delegation so canonical idempotent recovery remains in `PaymentsService`.
- No spec was skipped, deleted, weakened with `.only`, or made to reimplement settlement internals.

## Verification (2026-08-10)
- Focused admin spec: 3/3 passed.
- Combined focused run: 48/48 passed across 6 suites (`admin.flow`, payments, bank cards, panel installer, panel inbounds, VPN).
- Phase 2 added `crypto-wallets.service.spec.ts` and expanded admin/payment/gateway coverage; final Phase 2 results are recorded below.
- `npm run build`: passed.
- `git diff --check`: passed (line-ending warnings only).

## Phase 2 verification (2026-08-10)
- Focused admin/payment-method run: 32/32 passed across 5 suites (`admin.flow`, payments, bank cards, crypto wallets, Zarinpal gateway).
- `npm run build`: passed.
- `git diff --check`: passed (line-ending warnings only).

## Phase 3 verification (2026-08-10)
- Focused admin/menu run: 9/9 passed (`admin.flow`).
- Combined admin/payment-method run: 33/33 passed across 5 suites (`admin.flow`, payments, bank cards, crypto wallets, Zarinpal gateway).
- `npm run build`: passed.
- Dead callback/state grep: no executable server/panel Telegram UI references remain.
- `git diff --check`: passed (line-ending warnings only).

## Phase 4 final verification (2026-08-10)
- Focused AdminFlow run: 9/9 passed. Receipt decisions delegate to `PaymentsService.verifyReceipt`; menu, role protection, masked payment-method views, actionable empty state, navigation, service delegation, and gateway setting edits are covered.
- Full relevant regression run: 95/95 passed across 16 suites: AdminFlow, Telegram subscriptions, payments, bank cards, crypto wallets, Zarinpal gateway, orders, wallet, panel installer, panel inbounds, panels, XUI panel client, servers, VPN, subscriptions, and plans.
- Runtime configuration trace reconfirmed: AdminFlow writes canonical services/settings; card and crypto checkout resolve canonical defaults; `PaymentsService` and `DefaultZarinpalGateway` consume gateway enabled, merchant, callback, and sandbox settings at runtime.
- Callback/label audit: payment-method buttons have live Telegram registrations; no executable `adm:servers`, `adm:panels`, `apnl:*`, panel-wizard state, or incorrect `پنل سنتی` label remains. The removed callback names exist only in the negative regression assertion.
- Backend safety reconfirmed: Prisma panel/server/inbound/subscription relations and the panel installer, inbound synchronization, panel client/service, server service, XUI reconciliation scripts, VPN provisioning, and subscription/plan callers remain intact and tested.
- `npm run build`: passed.
- No Phase 4 product-code changes were required.

## Remaining limitations
- Gateway management is intentionally limited to the existing Zarinpal provider and runtime-effective enabled, merchant ID, callback URL, and sandbox settings; seeded runtime-inert API key/secret fields remain unexposed.
- Crypto settlement remains manual; this plan manages destinations but does not add chain monitoring.
- Bank-card removal is a safe deactivate/default-clear operation so payment history remains intact.

## Mandatory channel membership (2026-08-12)

- A global Telegram middleware checks every regular-user update before service/menu handlers; configured super-admins and persisted `SUPER_ADMIN`/`ADMIN`/`OPERATOR` users are exempt.
- Admins manage public required channels from `adm:join`: add by `@username`, remove, and enable/disable. Addition verifies that the target is a channel and the bot is its administrator before persisting canonical `SystemSetting` JSON.
- Blocked users receive one URL button per missing channel plus `عضو شدم`; the callback re-checks all memberships with Telegram `getChatMember` before continuing onboarding. Pending referral start payloads survive the join gate.

## Next action
Plan complete. No remaining phase.

## Post-plan regression fix (2026-08-11)
- Fixed the global `home` callback after admin plan creation: main-menu rendering now uses `BotRuntime.getMainMenuKeyboard`, the canonical role resolver that recognizes both the configured super-admin Telegram ID and persisted DB admin roles.
- This removes the fragile dependency on wizard/session `data` for retaining the admin menu.
- Added a TelegramBotService regression test proving Home renders the role-aware keyboard while resetting state and navigation.
- Focused Telegram/Admin run: 10/10 passed across 2 suites; `npm run build` and `git diff --check` passed.

## Referral and trial activation (2026-08-11)
- Referral signup now consumes the canonical seeded setting keys, records the relationship as pending until the first paid purchase, and credits the configured signup rewards to both wallets atomically.
- Canonical order completion credits the configured percentage commission once, subject to the reward cap, and marks the invited user active. The dashboard rank includes the current referrer even before their first invite.
- An idempotent production migration supplies missing referral/trial settings and a hidden 3-day/500MB trial plan. Each account receives at most one trial; a zero global limit means every account remains eligible regardless of daily volume.
- Trial provisioning now returns and sends the persisted XUI subscription link.
- Focused Auth/Order/Subscription/VPN/Telegram run: 36/36 passed across 6 suites; Prisma validation, `npm run build`, and `git diff --check` passed.
- Production migration `20260811160000_enable_referral_and_trial` completed on commit `8723bda`: referral settings are active, the 3-day/500MB `ALL_ACTIVE` trial plan exists, app/Redis/MinIO/nginx are healthy, `/health` and `/health/ready` return 200, and native XUI remains active.

## Receipt notification reliability (2026-08-11)
- Production root cause: `TELEGRAM_ADMIN_IDS` contained placeholder IDs while the real administrator was configured through `SUPER_ADMIN_TELEGRAM_ID`; receipt flows only targeted the former.
- `BotRuntime` now resolves the deduplicated union of configured IDs, configured super-admin, and active DB `SUPER_ADMIN`/`ADMIN`/`OPERATOR` Telegram IDs.
- Order and wallet receipts await one independent photo notification per receipt. Admin sends run concurrently, retain payment-scoped approve/reject/manage callbacks, and fall back to a text notification with the same buttons if photo delivery fails.
- Focused Telegram/payment run: 25/25 passed across 4 suites, including simultaneous receipt delivery and photo fallback; `npm run build` and `git diff --check` passed.
- Approval error follow-up: settlement succeeded, but a pre-existing XUI identity blocked the user's second subscription mapping. VPN identity collision handling now gives additional subscriptions a stable suffix and keeps approval retries idempotent.
