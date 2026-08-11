# Phase 5 — Real XUI Runtime Operations

## Goal

Remove fake local-only subscription state changes. Operations exposed by TAZAXY must actually reconcile with 3x-ui.

## Inspect and wire

Implement/reuse real panel operations for:

- suspend/disable
- resume/enable
- reset traffic
- renew/update quota+expiry
- delete remote client

Use the existing XuiPanelClient capabilities where already implemented/tested.

Do not duplicate XUI HTTP logic in VpnService.

VpnService/domain service should orchestrate; panel client should own panel API details.

## Ordering / consistency

Choose safe ordering per operation.

Examples:

Suspend:
remote disable succeeds
→ persist local suspended state

Resume:
remote enable succeeds
→ persist local active state

Reset:
remote reset succeeds
→ reconcile local usage

Renew:
paid settlement already happened
→ update existing remote client quota/expiry
→ persist/reconcile effective state

Delete:
remote deletion must be idempotent/not-found safe where appropriate
→ persist terminal local state according to architecture

Do not mark local operation successful if the required XUI operation failed.

Where partial failure is possible, keep state recoverable and explicit.

## Remove fake actions

Any UI/API route that calls a log-only stub must be:
- implemented for real, or
- hidden/disabled until implemented.

No placeholder success responses.

## Legacy cleanup

Now re-check legacy candidates found in Phase 1.

Remove obsolete:
- unused VPN/XUI models
- duplicate service paths
- dead helpers
- unused configuration

only after callers/tests have migrated.

Create Prisma migration only when schema removal is proven safe and intentional.

## Tests

Cover each remote operation and failure mode.

Ensure no panel credentials or subscription secrets leak to logs.

## STATE

Record real remote operations, removed legacy paths/models, migrations, and tests.

## Stop condition

Do not start final E2E in this session.
