# TAZAXY Agent Rules

## Source of truth
- Inspect executable code before README/HANDOFF/docs.
- Existing documentation is context, not proof.
- Trace real callers, Telegram callback registrations, DI wiring, services, Prisma models, and tests before changing behavior.
- Do not rewrite working subsystems merely because the repository is messy.

## Engineering rules
- Prefer one canonical implementation over duplicate paths.
- Apply Ponytail-style cleanup: remove dead/duplicate code only after proving no executable caller remains.
- Preserve existing service/domain logic where valid; do not create parallel admin systems.
- Telegram flows should delegate business logic to services, not duplicate database/payment logic inside AdminFlow.
- Use inline buttons, role protection, Back/Home navigation, actionable empty states, and masked sensitive values.
- Prefer editing the current Telegram message where the existing UI architecture supports it.
- Never expose payment secrets, gateway credentials, XUI credentials, subscription secrets, or private keys.
- Fix broken tests to represent correct behavior; do not weaken tests merely to make them green.

## Task plans
### XUI installer
Index: `docs/exec-plans/xui-installer/INDEX.md`
State: `XUI-INSTALLER-STATE.md`

### Payment → Subscription → XUI
Index: `docs/exec-plans/payment-provisioning/INDEX.md`
State: `PAYMENT-PROVISIONING-STATE.md`

### Telegram Admin UX / Payment Methods
Index: `docs/exec-plans/admin-telegram/INDEX.md`
State: `ADMIN-TELEGRAM-STATE.md`

Read only the active plan/phase plus direct dependencies.

## Cross-plan rules
- Admin Telegram work must consume existing payment services/models instead of creating parallel storage.
- XUI installer/reconciliation owns panel infrastructure discovery/connectivity.
- Do not delete `Server`, panel, or XUI backend models/services merely because their Telegram admin menu is unnecessary. Remove backend code only after proving no runtime caller/dependency remains.
- Payment settlement/provisioning invariants from the payment plan remain authoritative.

## Naming
- Replace incorrect admin UI label `پنل سنتی` with `پنل سنایی` wherever that exact typo exists in user-facing Telegram UI.
- Do not rename backend concepts merely to match a UI label unless code semantics prove they are the same concept.

## Verification
Run focused tests first.
Before declaring a plan complete:
- relevant admin/Telegram tests
- payment method service tests
- TypeScript typecheck/build
- `git diff --check`
Never claim a test passed unless it actually ran.
