# Phase 4 — Final Verification

## Goal
Verify simplified admin UX, payment configuration, and AdminFlow suite end-to-end at code/test level.

## Verify menu
- no dead buttons
- no incorrect `پنل سنتی`
- payment-method management clear
- Back/Home work
- role/admin protection intact

## Verify payment configuration
Bank cards: add/edit/list/enable-disable/default/remove or safe equivalent; purchase flow sees intended cards.
Crypto: add/edit/list/remove/enabled behavior; no secret leakage.
Gateways: runtime provider config editable; enabled state correct; secrets masked; real runtime consumes changes.

## Verify backend safety
Search `Server`/panel backend use again.
If Telegram menu removed, ensure XUI reconciliation, panel/inbound sync, provisioning, and Prisma relations still work.

## Verify AdminFlow
`admin.flow.spec.ts` must pass for correct reasons.

Also run relevant AdminFlow/Telegram tests, payment-config tests, payment settlement tests affected by callbacks, panel/XUI tests affected by menu wiring, typecheck/build, and `git diff --check`.

## Final report
Report:
1. why spec failed and fix
2. final admin menu
3. bank-card capabilities
4. crypto capabilities
5. gateway capabilities
6. panel/server Telegram UI removed/kept and why
7. backend components preserved
8. dead callbacks/files removed
9. exact tests/results
10. remaining limitations

Update `ADMIN-TELEGRAM-STATE.md`.
