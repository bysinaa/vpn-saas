# Payment → Subscription → XUI Provisioning — Index

## Goal

Make one reliable purchase lifecycle:

Telegram user
→ admin-created plan
→ order
→ payment
→ canonical settlement
→ subscription
→ exactly one 3x-ui client
→ subscription URL
→ Telegram delivery
→ live usage / remaining traffic / remaining days

Renew/extend must use the same paid lifecycle and update the existing XUI client safely.

## Phases

1. `01-audit-cleanup.md`
   Audit payment/provisioning call graph and remove or isolate duplicate/dead paths.

2. `02-payment-settlement.md`
   Create one canonical idempotent settlement path for wallet, card receipt, and gateway-confirmed order payments.

3. `03-provisioning.md`
   Harden subscription creation and exactly-once XUI provisioning using plan quota/duration/inbounds.

4. `04-telegram-lifecycle.md`
   Deliver link/status cleanly in Telegram and convert renew/extend into paid order flows.

5. `05-runtime-operations.md`
   Wire real XUI suspend/resume/reset/renew/delete behavior and remove fake UI/actions.

6. `06-verify-e2e.md`
   Full regression, real opt-in XUI E2E, cleanup, and final acceptance.

## Global invariants

- One canonical payment settlement path.
- An order payment must NOT also credit wallet balance.
- A standalone wallet top-up may credit wallet only when it is not tied to an order.
- Duplicate callbacks/admin approvals must never double-settle, double-credit, or double-provision.
- External XUI provisioning happens after the DB transaction commits.
- Provisioning must be idempotent/recoverable.
- Plan traffic/duration are the source for subscription quota/expiry.
- One subscription/user purchase creates one logical XUI client, even when attached to multiple inbounds.
- Shared quota must not multiply by inbound count.
- Client identity must be recognizable from Telegram identity and remain stable enough for operations.
- Preferred XUI email/name:
  `tg_<sanitizedTelegramUsername>_<telegramId>`
  fallback:
  `tg_<telegramId>`
- Telegram ID is the stable identity; username is display/recognition metadata and may change.
- One canonical subscription URL builder; honor configured subscription port/path.
- Telegram status must use real panel usage when available.
- No free renew/extend through direct DB date updates.
- Hide/remove UI actions that are not genuinely implemented.
- Do not create new XUI discovery/auth infrastructure in this plan.
- Do not trust README/HANDOFF over executable code.

## Persistent state

Every phase updates:
`PAYMENT-PROVISIONING-STATE.md`

Keep it compact: verified architecture, decisions, modified files, tests, blockers, exact next action.
