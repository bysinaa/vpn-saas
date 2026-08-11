# Phase 1 — Admin Menu Audit + Fix admin.flow.spec.ts

## Goal
Establish a green, trustworthy baseline before changing the menu.

## Inspect
Trace real executable paths for:
- `AdminFlow`
- `admin.flow.spec.ts`
- Telegram callback registration/dispatch
- admin keyboard builders
- bank-card services
- crypto wallet/payment settings services
- gateway settings/providers
- panel/server admin callbacks
- admin/role guards

## Menu map
Record current menu entries/callback IDs for:
- bank cards
- crypto
- gateways
- `پنل سنتی` / `پنل سنایی`
- servers
- panels
- duplicate/placeholder settings

For each identify handler, service/model, whether functional/duplicate, and whether removing only the Telegram entry affects backend runtime.

## admin.flow.spec.ts
Fix it properly:
- determine stale expectation vs broken mock/DI vs real implementation bug;
- fix production code when behavior is wrong;
- fix test expectations/mocks when the test is obsolete;
- do not skip, `.only`, weaken, or delete meaningful assertions;
- preserve canonical payment settlement invariants;
- add focused regression assertions for callbacks/menu behavior affected here.

Run the specific spec until stable.

## Backend safety audit
Before later deletion, trace `Server`/panel use in:
- XUI installer reconciliation
- `VpnPanel`
- `Server`
- `InboundConfig`
- `PanelInboundsService`
- provisioning selection
- controllers/CLI
- Prisma relations/migrations
- tests

Default outcome: remove unnecessary Telegram UX, not runtime infrastructure.

## STATE
Update `ADMIN-TELEGRAM-STATE.md` with menu/callback map, exact spec failure cause/fix, test result, backend dependencies, and dead UI candidates.

## Stop
Do not start Phase 2.
