# Payment / Provisioning State

Persistent working memory for Codex sessions. Keep this file concise and replace stale history.

## Current phase

Phase 1 — COMPLETE (2026-08-10)

Phase 2 — COMPLETE (2026-08-10)

Phase 3 — COMPLETE (2026-08-10)

Phase 4 — COMPLETE (2026-08-10)

Phase 5 — COMPLETE (2026-08-10)

Phase 6 — COMPLETE (2026-08-10)

Payment → subscription → XUI provisioning plan — COMPLETE.

## Post-plan trial delivery fix (2026-08-11)

- `SubscriptionsService.provision` now refetches after XUI provisioning so synchronous callers receive the persisted subscription link.
- Telegram trial delivery includes that real link. Production defaults create one hidden 3-day/500MB trial plan and allow one trial per account without a global daily cap.
- Referral purchase commission runs inside canonical order completion, so order idempotency also prevents duplicate rewards.
- Production verification confirmed the migration finished and the hidden trial plan has a 536870912-byte quota, 3-day duration, ACTIVE/enabled state, and `ALL_ACTIVE` inbound policy.
- Receipt submission remains canonical in `PaymentsService`; Telegram now reliably delivers each stored receipt to all authorized admins with payment-specific decision callbacks, including under simultaneous uploads.
- Production receipt approval exposed a second-subscription collision on unique `VpnUser.panelUserId`. The first subscription retains `tg_<username>_<telegramId>`; later subscriptions deterministically use `_s<subscriptionId>`, and a P2002 retry closes the simultaneous-claim race without repeating payment settlement.
- The affected Production receipt/payment/order are already `APPROVED`/`CONFIRMED`/`COMPLETED`; only subscription provisioning remains to be retried through canonical idempotent receipt verification. Focused VPN/payment/admin run: 40/40 passed; `npm run build` and `git diff --check` passed.
- Production recovery completed on commit `f3b6c72`: subscription 4 and its suffixed XUI mapping are ACTIVE with a persisted link and no sync error; the user received one marked recovery notification. The payment has zero wallet transactions, confirming no duplicate debit/credit during retry. App is healthy and readiness returns 200.

## Post-plan online gateway UX fix (2026-08-12)

- Online initiation returns the persisted Zarinpal redirect URL to Telegram, so the URL button opens the hosted payment page.
- The public callback verifies and settles through the canonical payment service, then renders a minimal Persian success/failure HTML page instead of raw JSON.
- Successful non-wallet order settlement sends the user a Telegram confirmation with the provisioned subscription link; duplicate callback delivery remains notification-idempotent.

## Canonical payment settlement

- `PaymentsService.confirmPayment` is the service-level entry point for confirmed gateway, receipt, crypto/manual retry, and recovery settlement.
- `PaymentsService.settlePaymentInTransaction` atomically confirms the payment and either calls `OrdersService.completeOrderInTransaction` or creates the standalone top-up wallet transaction.
- Order payments never credit wallet. A wallet credit is possible only when `payment.orderId` is null, and the unique `WalletTransaction.paymentId` makes the credit idempotent.
- `PaymentsService.payOrderWithWallet` locks the order, creates the payment, debits wallet, confirms payment, completes the order, and creates/updates the subscription in one transaction.
- Receipt decision CAS and settlement share one transaction. External XUI provisioning runs only after the settlement transaction commits.

## Canonical provisioning

- `VpnService.createVpnUserForSubscription` is the single provisioning entry point used by payment settlement, renew/extend, and voucher subscription creation.
- Provisioning uses the subscription's immutable `provisioningPanelId` and deduplicated/sorted `provisioningInboundIds` snapshot.
- One unique `VpnUser.subscriptionId` mapping is atomically claimed before remote I/O. Its stable XUI email and UUID `subToken` are reused by sequential and concurrent retries.
- XUI identity is recognizable: `tg_<sanitized_username>_<telegram_id>`, falling back to `tg_<telegram_id>` when the Telegram username is absent. Telegram ID, username, and inbound IDs are also retained in mapping metadata.
- Provisioning performs get-before-create. Existing remote clients are updated; ambiguous create failures are reconciled by identity before a bounded retry. Failures leave a retryable DISABLED mapping with a safe `syncError` and do not expose raw panel errors or secrets.
- Quota, duration/expiry, and device limit come from the selected plan. The plan's total traffic quota is applied once to the client while the same client is attached to every snapshot inbound, preserving shared quota rather than multiplying it per inbound.
- Renew/extend refreshes quota, duration, device limit, and expiry from the current plan, including unlimited/null values.
- `buildSubscriptionUrl` in `src/modules/panels/panel-client.interface.ts` is the shared URL builder used by XUI response mapping, VPN provisioning, and usage lookup. It respects panel or configured subscription port/path and URL-encodes the token.
- Post-commit callers await provisioning and propagate failures, so they cannot report delivery before XUI succeeds. Payment/order DB settlement remains committed and duplicate confirmation safely retries provisioning.

## Telegram purchase and status lifecycle

- Wallet completion refetches the provisioned subscription and returns/displays the real subscription link; a completed order without a link is reported as provisioning pending, never as purchase success.
- Confirmed card/gateway order payments provision first, then persist and deliver a Telegram completion notification containing the plan and link. Failed/pending provisioning sends a safe confirmed-payment/pending message and remains retryable without a second payment.
- Telegram subscription detail uses live panel used/total traffic, panel status, and one effective panel expiry for both the displayed expiry and remaining-day calculation. It shows remaining traffic and no longer hardcodes a protocol.
- Public plan listing remains restricted to visible + enabled + ACTIVE plans; order creation independently rejects disabled/inactive plans. UUID-backed fallback slugs remain in place for Persian-only names.

## Paid renewal and extension

- `RENEW` and `EXTEND` create normal pending orders and enter the existing wallet/online/card/crypto payment-method flow. Direct free subscription renew/extend service methods and REST endpoints were removed.
- Renewal orders must target an exact owned subscription through the existing `Order.subscriptionId` relation, must use the same renewable plan, and have quantity one.
- Settlement updates that exact subscription and then re-enters canonical idempotent provisioning, which updates the existing `VpnUser`/XUI identity rather than creating a second client.
- Order completion stores the resulting subscription relation for idempotent callback/recovery lookup.
- The fake upgrade button, callback registrations, conversation state, picker, success handler, and unused upgrade copy were removed because no paid proration flow exists.

## Canonical runtime XUI operations

- `VpnService` now performs real XUI suspend, resume, traffic reset, and deletion through the canonical panel client before changing local state.
- Successful suspend/resume updates `VpnUser`, `Subscription`, and `SubscriptionEvent` together after remote success. Failed remote calls preserve the prior local status and record only a generic retry-safe `syncError`.
- Successful traffic reset reconciles both local usage counters to zero after the panel reset and records a `RESET` event.
- Client deletion is get-before-delete and not-found safe. An ambiguous delete is reconciled by identity; local cancellation, link removal, event creation, and mapping deletion happen only after the remote client is confirmed absent.
- Paid renew/extend remains the one canonical renewal path: settlement updates the subscription, then `createVpnUserForSubscription` updates the existing XUI identity with current quota, expiry, device limit, and token.
- Runtime-operation logs contain identifiers only and do not include panel errors, credentials, subscription tokens, or links.

## Migrated executable callers

- Public Zarinpal callback -> `handleOnlineCallback` -> gateway verify -> `confirmPayment`.
- REST receipt approval and Telegram `payapprove`/`payreject` callbacks -> `verifyReceipt`.
- REST and Telegram wallet order payment -> `payOrderWithWallet`.
- Gateway/receipt/manual settlement, subscription renew/extend, and voucher subscription creation -> canonical `VpnService.createVpnUserForSubscription` after commit.
- All executable subscription URL construction -> canonical `buildSubscriptionUrl`.

## Verified invariants

- Repeated and simultaneous provisioning attempts converge on one stable remote identity and subscription token.
- A 30 GB plan attached to multiple inbounds remains one 30 GB shared quota, not 30 GB per inbound.
- Retry after an ambiguous remote response reconciles the existing client without duplicate creation.
- Provisioning failure is persisted safely and propagated; retry reuses the same mapping and can complete it.
- Repeated receipt/gateway confirmation creates one logical order/subscription and safely re-enters provisioning after a prior post-commit failure.
- Failed/NOK payments do not complete orders; order payments never credit wallet; standalone wallet top-ups credit once.

## Retained cleanup

- Disabled plans are hidden and rejected during order creation; Persian-only plans receive UUID-backed stable slugs.
- The unregistered legacy `src/integrations/xui/` module was removed; `PanelsService` / `XuiPanelClient` remains canonical.
- Explicit demo/placeholder payment seed data was removed without deleting existing database rows.
- The local-only pause endpoint and plan/API/admin pause capability were removed because no real expiry-preserving XUI pause semantics exist.
- The placeholder VPN sync endpoint, unregistered `VpnProcessor` stub, dead panel queue/job names, log-only renewal duplicate, and unused XUI panel sync cron configuration were removed.
- `XuiPanelClient.deleteUser` now delegates to its canonical validated `deleteClient` implementation.
- Prisma `VpnClient` and `XuiConnection` remain executable-code unused but were not dropped; production-data review and a deliberate migration are required before destructive schema deletion.
- Removed the tracked `scripts/e2e/retained-xui-lifecycle.cjs` false-verification path after proving it had no package/CI/runtime caller and called the removed `OrdersService.completeOrder` API instead of canonical payment settlement.

## Phase 6 final acceptance

- Executable-code searches found no duplicate receipt settlement, direct free renew/extend service calls, random-only XUI naming, fake upgrade callback, log-only VPN runtime operation, or legacy `src/integrations/xui`/`VpnProcessor` reference.
- Runtime subscription URLs use `buildSubscriptionUrl`; the separate CLI installer URL formatter remains owned by the XUI installer plan.
- The complete application Jest suite, Prisma validation/client generation, Nest build, CLI build, installer regression, and diff hygiene were selected for final verification.
- Real XUI write E2E was not run: `TAZAXY_E2E_ALLOW_WRITE=true` was absent from process, user, machine, and `.env` scope. No real client or panel resource was created, changed, retained, or deleted.

## Verified risks for later phases

- Crypto order initiation still has no confirmed executable verifier/job and remains pending/manual.

## Files changed in Phase 6

- Removed `scripts/e2e/retained-xui-lifecycle.cjs` because it was an unregistered, stale test path that bypassed canonical payment confirmation.
- Finalized `PAYMENT-PROVISIONING-STATE.md`.

## Files changed in Phase 5

- `src/modules/vpn/vpn.service.ts`, controller, runtime tests, and removal of the unused processor.
- `src/modules/panels/xui-panel.client.ts`.
- `src/modules/subscriptions/subscriptions.service.ts` and controller.
- `src/modules/plans/plans.service.ts`, schemas, and Telegram admin plan display.
- `src/config/index.ts`, env validation, and `src/common/queue/queue-names.ts`.
- `PAYMENT-PROVISIONING-STATE.md`.

## Files changed in Phase 4

- `src/modules/orders/orders.service.ts`, schema/controller, and order tests.
- `src/modules/subscriptions/subscriptions.service.ts`, controller, and tests.
- `src/modules/payments/payments.service.ts` and payment tests.
- `src/modules/notifications/notifications.service.ts` and `broadcast.service.ts`.
- `src/modules/telegram/flows/buy.flow.ts`, `subscriptions.flow.ts`, its focused tests, keyboards, callback registration/types, and i18n.
- `PAYMENT-PROVISIONING-STATE.md`.

## Tests last run

- Focused payment command: `node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/modules/payments/payments.service.spec.ts` — 1 suite, 9 tests passed.
- Relevant payment/provisioning regression command — 13 suites, 71 tests passed.
- Whole application command: `node node_modules/jest/bin/jest.js --runInBand` — 15 suites, 82 tests passed.
- `npx prisma validate` passed.
- `npm run prisma:generate` passed (Prisma Client v5.22.0 generated).
- `npm run build` passed.
- `npm run cli:build` passed.
- `npm run test:installer` passed — 54 tests passed.
- `git diff --check` passed; output contained only existing LF→CRLF conversion warnings.
- Real XUI E2E was not run because explicit write opt-in was disabled.

## Next action

No next phase. The payment/provisioning execution plan is complete. Any future work should start from the remaining crypto-verification limitation or a separately authorized real-panel write E2E.
