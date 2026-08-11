# Phase 3 — Admin Menu Simplification + Ponytail Cleanup

## Goal
Make Telegram admin menu smaller/useful without deleting backend XUI/provisioning infrastructure.

## Label
Replace user-facing exact typo:
`پنل سنتی` → `پنل سنایی`
Do not mass-rename backend identifiers.

## Panel / Server menu
Use Phase 1 evidence.

If Telegram Server/panel-management sections add no useful/safe operator workflow:
- remove top-level Telegram buttons;
- remove unreachable/dead callbacks;
- remove obsolete AdminFlow-only state/formatting;
- update tests.

Do NOT delete backend `Server`, `VpnPanel`, `InboundConfig`, panel services, XUI client, reconciliation services, Prisma relations, or migrations if runtime depends on them.

If one panel action remains genuinely useful (e.g. health/diagnostics), prefer a small diagnostic entry over full manual configuration.

## General cleanup
Audit admin home keyboard for duplicates, placeholders, mislabeled buttons, useless sections.
Group payment settings logically: Bank cards / Crypto / Payment gateways.

## Ponytail cleanup
After removing menu entries:
1. grep callback IDs;
2. trace registrations;
3. remove handlers with no executable caller;
4. remove obsolete flow-state branches;
5. remove stale tests/fixtures only after replacing with current behavior.

Do not delete shared services because AdminFlow no longer calls them.

## Tests
Run admin menu rendering, callback routing, `admin.flow.spec.ts`, payment-method admin tests, typecheck, `git diff --check`.

## STATE
Record final menu, removed callbacks/code, preserved backend components.

## Stop
No broad unrelated refactors.
