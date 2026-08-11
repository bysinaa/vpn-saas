# راهنمای Codex — Payment → Subscription → XUI

## قبل از شروع

این Add-on را روی همان repo که فایل‌های XUI plan را دارد بریز.

`AGENTS.md` جدید را جایگزین نسخه قبلی کن؛ این نسخه هر دو plan را می‌شناسد.

فایل‌های XUI قبلی را حذف نکن.

ساختار باید شبیه این باشد:

AGENTS.md
XUI-INSTALLER-STATE.md
PAYMENT-PROVISIONING-STATE.md

docs/exec-plans/xui-installer/...
docs/exec-plans/payment-provisioning/...

## قانون

هر Phase = یک Codex Session جدید.

بعد از هر Phase:
1. diff را review کن
2. مطمئن شو تست‌ها واقعاً اجرا شده‌اند
3. commit کن
4. session را ببند
5. Phase بعدی را در session جدید شروع کن

پرامپت هیولا را دوباره نفرست.

---

# SESSION 1 — Audit + Ponytail

Read `AGENTS.md`, `PAYMENT-PROVISIONING-STATE.md`, `docs/exec-plans/payment-provisioning/INDEX.md`, and `docs/exec-plans/payment-provisioning/01-audit-cleanup.md`.

Execute Phase 1 completely against the real executable code. Trace the actual payment → order → subscription → XUI call graph, perform only evidence-based Ponytail cleanup, run focused checks, and update `PAYMENT-PROVISIONING-STATE.md`.

Do not start Phase 2.

---

# SESSION 2 — Canonical Payment Settlement

Continue the payment/provisioning work.

Read `AGENTS.md`, `PAYMENT-PROVISIONING-STATE.md`, `docs/exec-plans/payment-provisioning/INDEX.md`, and `docs/exec-plans/payment-provisioning/02-payment-settlement.md`.

Execute Phase 2 completely. Eliminate duplicate settlement behavior, make order payment confirmation exactly-once, and ensure order payments never also credit wallet. Migrate real callers to the canonical settlement service, run focused tests, and update the state file.

Do not start Phase 3.

---

# SESSION 3 — Subscription + XUI Provisioning

Continue the payment/provisioning work.

Read `AGENTS.md`, `PAYMENT-PROVISIONING-STATE.md`, `docs/exec-plans/payment-provisioning/INDEX.md`, and `docs/exec-plans/payment-provisioning/03-provisioning.md`.

Execute Phase 3 completely. Make provisioning exactly-once and plan-driven, use recognizable Telegram-based XUI identity, preserve shared quota across multiple inbounds, consolidate subscription URL construction, run focused tests, and update the state file.

Do not start Phase 4.

---

# SESSION 4 — Telegram Lifecycle

Continue the payment/provisioning work.

Read `AGENTS.md`, `PAYMENT-PROVISIONING-STATE.md`, `docs/exec-plans/payment-provisioning/INDEX.md`, and `docs/exec-plans/payment-provisioning/04-telegram-lifecycle.md`.

Execute Phase 4 completely. Make purchase completion and subscription status reflect real provisioning/usage, convert renew/extend into paid order flows, remove fake upgrade behavior, run focused tests, and update the state file.

Do not start Phase 5.

---

# SESSION 5 — Real XUI Operations

Continue the payment/provisioning work.

Read `AGENTS.md`, `PAYMENT-PROVISIONING-STATE.md`, `docs/exec-plans/payment-provisioning/INDEX.md`, and `docs/exec-plans/payment-provisioning/05-runtime-operations.md`.

Execute Phase 5 completely. Replace log-only/local-only VPN operations with real canonical XUI operations, remove proven legacy paths, run focused tests, and update the state file.

Do not start Phase 6.

---

# SESSION 6 — Final Verification / E2E

Finish the payment/provisioning execution plan.

Read `AGENTS.md`, `PAYMENT-PROVISIONING-STATE.md`, `docs/exec-plans/payment-provisioning/INDEX.md`, and `docs/exec-plans/payment-provisioning/06-verify-e2e.md`.

Execute Phase 6 completely. Run the full relevant regression suite and the real XUI E2E only if explicit write-test opt-in is enabled. Remove remaining false-success paths, finalize the state file, and report only tests that actually ran.

---

# جمله‌های طلایی

## اگر فقط گزارش داد و کد نزد

This is an implementation task, not an architecture report. Apply the required code changes now, migrate the real callers, run the focused tests, and update the state file with verified results.

## اگر دوباره کل repo را از اول اسکن کرد

Do not repeat repository-wide discovery already captured in `PAYMENT-PROVISIONING-STATE.md`. Re-verify only facts affected by changed code and inspect only direct dependencies of the current phase.

## اگر duplicate logic نگه داشت

For every duplicate or compatibility payment/provisioning path you want to keep, identify its current executable caller and explain why the canonical path cannot serve it. If no valid caller/need exists, migrate and remove it.

## اگر transaction را با XUI call قاطی کرد

Do not hold a database transaction open across external 3x-ui/network calls. Commit canonical settlement/subscription state first, then perform idempotent external provisioning with recoverable failure handling.

## اگر order payment کیف پول را هم شارژ کرد

An order payment is payment for the order, not a wallet deposit. Do not credit wallet when `payment.orderId` represents the purchased order. Only a genuine standalone wallet top-up may credit wallet.

## اگر duplicate client ساخت

Provisioning retries must be idempotent. Before creating another remote XUI client, use the persisted subscription/VpnUser mapping and deterministic identity to prove whether the logical client already exists.

## اگر اسم XUI را random گذاشت

Use recognizable Telegram identity for the XUI client: `tg_<sanitized_username>_<telegramId>`, falling back to `tg_<telegramId>`. Telegram ID is stable; username is optional display identity.

## اگر renew/extend رایگان کرد

Renew/extend is a paid lifecycle. Do not directly mutate expiry/quota as a user-facing renewal action. Create an order, settle payment canonically, then update the existing subscription and remote XUI client.

## اگر fake button نگه داشت

A UI action that is not fully implemented must not return success. Implement it against the canonical domain path or hide/remove it.

## اگر link را دستی ساخت

Do not construct subscription URLs ad hoc. Use one canonical URL builder that honors the discovered/configured subscription scheme, host, port, path, and token/subId.

## اگر تست قدیمی رفتار غلط را enforce کرد

Tests that encode the old incorrect business behavior are not compatibility requirements. Rewrite them to assert the canonical invariants in the current execution plan.

## اگر context داشت بزرگ می‌شد

Compact `PAYMENT-PROVISIONING-STATE.md`. Keep only verified current architecture, canonical entry points, changed/removed files, invariants, test status, blockers, and the exact next action. Remove stale investigation history.

## اگر XUI installer را دوباره ساخت

Do not create another XUI detector, auth stack, credential store, or inbound discovery path. Consume the canonical panel infrastructure produced by the XUI installer execution plan.

## اگر خواست همه چیز را یکجا rewrite کند

Do not rewrite the subsystem wholesale. Preserve tested working components, migrate one canonical path at a time, delete duplicates only after callers move, and keep each phase independently verifiable.

## اگر session نیمه‌کاره ماند

Before stopping, update `PAYMENT-PROVISIONING-STATE.md` with every verified finding, completed change, test result, unresolved blocker, and the exact next executable step. Keep it concise enough for a fresh Codex session.
