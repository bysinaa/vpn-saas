# Phase 6 — Final Verification + Opt-in E2E

## Goal

Prove the complete paid lifecycle and remove remaining false-success/legacy behavior.

## Full lifecycle acceptance

Test the conceptual flow:

Telegram user
→ visible enabled plan
→ order
→ payment confirmation
→ exactly-once settlement
→ subscription
→ exactly-one XUI client
→ correct quota
→ correct expiry
→ correct inbound attachment
→ canonical subscription URL
→ Telegram delivery
→ live usage/status
→ paid renewal updates existing remote client

## Real XUI E2E

Only perform destructive/write E2E against a real 3x-ui panel when an explicit opt-in environment flag already exists or is deliberately added for this purpose.

Never silently create real clients on ordinary test runs.

A safe test scenario should use a tiny obvious test plan/client identity and verify:

- client exists exactly once
- XUI name includes Telegram identity
- quota matches plan
- expiry approximately matches purchased duration
- `tgId`/Telegram mapping correct where supported
- expected inbound IDs attached
- subscription URL works/has correct configured base
- traffic endpoint returns readable usage
- duplicate payment confirmation creates no second client
- renewal updates existing client rather than creating another

Cleanup policy must be explicit. If existing project policy says test clients should remain for manual verification, respect that; otherwise clean only test-owned resources.

## Regression

Run all relevant:

- payment tests
- admin flow tests
- order tests
- subscription tests
- VPN/XUI client tests
- Telegram flow tests
- Prisma/typecheck/build
- CLI/app build as affected
- `git diff --check`

Search for:
- old duplicated receipt settlement
- direct free renew/extend calls
- random-only XUI naming
- duplicate subscription URL builders
- log-only VpnService operations
- fake upgrade success
- obsolete legacy paths identified in Phase 1

## Final response

Report concretely:

1. critical bugs fixed
2. files removed
3. important files changed
4. canonical payment flow
5. canonical provisioning flow
6. Telegram UX behavior
7. renew/extend behavior
8. runtime XUI operations
9. tests actually run/results
10. real XUI E2E result, or clearly state it was not run
11. remaining limitations

Update `PAYMENT-PROVISIONING-STATE.md` one final time.
