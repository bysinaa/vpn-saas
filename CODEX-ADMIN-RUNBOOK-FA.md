# راهنمای Codex — Telegram Admin

## نصب
این ZIP را روی root همان repo extract کن.
`AGENTS.md` جدید را جایگزین قبلی کن.
فایل‌های XUI و Payment قبلی را حذف نکن.

اضافه می‌شود:
- `ADMIN-TELEGRAM-STATE.md`
- `docs/exec-plans/admin-telegram/*`

## قانون
هر Phase = Session جدید Codex.
Sessionهای قبلی را لازم نیست حذف کنی؛ فقط داخلشان ادامه نده.
بعد از هر Phase: diff → tests → commit → session جدید.

# SESSION 1 — Audit + Fix Spec

Read `AGENTS.md`, `ADMIN-TELEGRAM-STATE.md`, `docs/exec-plans/admin-telegram/INDEX.md`, and `docs/exec-plans/admin-telegram/01-audit-spec.md`.

Execute Phase 1 completely against the real executable code. Map the actual Telegram admin menu/callback graph, determine the real purpose and runtime dependencies of the panel/server sections, fix `admin.flow.spec.ts` for the correct behavior, run focused tests, and update `ADMIN-TELEGRAM-STATE.md`.

Do not start Phase 2.

# SESSION 2 — Payment Methods

Continue the Telegram admin work.

Read `AGENTS.md`, `ADMIN-TELEGRAM-STATE.md`, `docs/exec-plans/admin-telegram/INDEX.md`, and `docs/exec-plans/admin-telegram/02-payment-methods.md`.

Execute Phase 2 completely. Implement admin Telegram management for bank cards, crypto payment configuration, and existing payment gateways by reusing canonical services/models. Keep secrets masked, preserve admin authorization/navigation, run focused tests, and update the state file.

Do not start Phase 3.

# SESSION 3 — Menu Cleanup

Continue the Telegram admin work.

Read `AGENTS.md`, `ADMIN-TELEGRAM-STATE.md`, `docs/exec-plans/admin-telegram/INDEX.md`, and `docs/exec-plans/admin-telegram/03-menu-cleanup.md`.

Execute Phase 3 completely. Simplify the admin menu, correct `پنل سنتی` to `پنل سنایی`, remove redundant panel/server Telegram UI and dead callbacks only where Phase 1 proved it safe, preserve backend infrastructure required by XUI/provisioning, run focused tests, and update the state file.

Do not start Phase 4.

# SESSION 4 — Final Verify

Finish the Telegram admin execution plan.

Read `AGENTS.md`, `ADMIN-TELEGRAM-STATE.md`, `docs/exec-plans/admin-telegram/INDEX.md`, and `docs/exec-plans/admin-telegram/04-verify.md`.

Execute Phase 4 completely. Run the full relevant admin/payment regression checks, verify payment-method edits reach the real runtime configuration, confirm XUI/provisioning backend dependencies remain intact, finalize the state file, and report only tests that actually ran.

# جمله‌های طلایی

## فقط report داد
This is an implementation task, not a menu audit report. Apply the required code changes now, migrate real callbacks to canonical services, run the focused tests, and update `ADMIN-TELEGRAM-STATE.md`.

## خواست Server backend را پاک کند
Removing an unnecessary Telegram admin menu does not justify deleting runtime infrastructure. Before deleting `Server`, `VpnPanel`, `InboundConfig`, or panel services, prove there are no executable callers across XUI reconciliation, inbound sync, provisioning, DI, Prisma relations, CLI, and tests. Otherwise preserve the backend and remove only the admin UI.

## payment config دوباره ساخت
Do not create a parallel payment-configuration system. Reuse the existing bank-card, crypto, gateway/settings services and persistence consumed by the real purchase/payment runtime.

## AdminFlow مستقیم Prisma زد
Keep AdminFlow focused on Telegram UI/orchestration. Move or reuse business mutations in the canonical service layer instead of adding direct duplicate Prisma/payment logic inside the flow.

## test را skip کرد
Do not skip, delete, weaken, or `.only` the failing `admin.flow.spec.ts` just to get green. Identify whether the implementation, mock wiring, or obsolete expectation is wrong and fix the correct layer.

## secret را نمایش داد
Never echo stored gateway/payment secrets in Telegram. Accept updates securely, persist through the canonical secret path where available, and show only masked/configured status afterward.

## context بزرگ شد
Compact `ADMIN-TELEGRAM-STATE.md`. Keep only the verified current menu/callback map, canonical services, changed/removed files, backend dependencies that must remain, test status, blockers, and the exact next action.

## کل repo را دوباره اسکن کرد
Do not repeat repository-wide discovery already recorded in `ADMIN-TELEGRAM-STATE.md`. Inspect only changed code and direct dependencies of the current phase.

## session نیمه‌کاره ماند
Before stopping, update `ADMIN-TELEGRAM-STATE.md` with every verified finding, completed change, test result, unresolved blocker, and the exact next executable step. Keep it concise for a fresh Codex session.
