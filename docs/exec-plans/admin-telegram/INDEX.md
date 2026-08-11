# Telegram Admin UX + Payment Method Management — Index

## Goal
Simplify the Telegram admin menu and make payment-method configuration manageable from Telegram without duplicate business logic.

Target outcomes:
- Bank cards manageable from Telegram.
- Crypto payment destinations manageable from Telegram.
- Online payment gateways manageable/configurable from Telegram using existing services/settings.
- Incorrect `پنل سنتی` label corrected to `پنل سنایی`.
- Redundant admin panel/server menu sections removed when they add no operator value.
- Backend `Server`/panel infrastructure preserved if provisioning/reconciliation depends on it.
- Broken `admin.flow.spec.ts` repaired correctly.
- AdminFlow reduced by delegating domain logic to services.

## Phases
1. `01-audit-spec.md` — audit menu/callback graph and fix `admin.flow.spec.ts`.
2. `02-payment-methods.md` — Telegram CRUD/config for bank cards, crypto, gateways.
3. `03-menu-cleanup.md` — remove redundant panel/server UI safely, fix labels, Ponytail cleanup.
4. `04-verify.md` — regression/security/UX verification.

## Global invariants
- AdminFlow is UI/orchestration, not a second payment domain layer.
- Reuse existing BankCards/Crypto/Payments/Settings/Gateway services/models.
- Do not create duplicate payment configuration storage.
- Sensitive values are masked after entry.
- Destructive admin actions require deliberate confirmation where appropriate.
- Every callback remains admin/role protected.
- Back/Home navigation works.
- Empty lists have an actionable next step.
- Removing a Telegram menu does NOT imply deleting its backend model.
- `Server`/panel backend deletion requires executable-use proof across provisioning, XUI reconciliation, inbounds, DI, tests, CLI, and migrations.
- Do not skip/disable broken specs.

## Persistent state
Every phase updates `ADMIN-TELEGRAM-STATE.md`.
Keep it concise.
