# Phase 4 — Telegram Purchase / Subscription Lifecycle

## Goal

Telegram should expose the real paid subscription lifecycle clearly and should never offer free or fake operations.

## Purchase completion UX

After successful payment + successful provisioning, send a useful completion message containing the subscription link or a clear button to retrieve it.

Do not make the user hunt through menus after a successful purchase.

If payment is confirmed but provisioning is pending/failed:
- say provisioning is pending/failed safely;
- do not send a fake success/link;
- allow retry/recovery through the canonical backend path.

## Subscription detail

Show real/current:

- plan/name
- used traffic
- total traffic
- remaining traffic
- expiry
- remaining days
- status
- subscription link

Use live XUI/panel traffic retrieval where available.

Use one effective expiry source consistently in both calculation and display.

Do not calculate days from panel expiry while displaying a stale DB expiry.

Do not hardcode protocol text such as `v2ray` if real protocol is available.

## Plan visibility

Public plan listing should require the proper enabled + active + visible conditions.

Fix Persian-safe/stable slug behavior if current slug generation can become empty/invalid.

## Renew / extend

Remove direct free DB mutations.

Renew/extend must become:

select renewal/extension offer
→ create order
→ pay
→ canonical settlement
→ update subscription
→ update existing XUI client quota/expiry
→ show updated status/link

Do not create a second XUI client for normal renewal of the same subscription when the architecture expects updating the existing client.

## Upgrade

If a correct paid upgrade/proration flow is not actually implemented, hide/remove the upgrade button/action.

Never keep a button that returns a fake success message.

## Tests

Cover:

- successful wallet/card/gateway purchase reaches delivery
- link shown only after provisioning success
- status displays live usage
- remaining traffic calculation
- remaining days consistent with displayed expiry
- disabled plan not purchasable
- Persian plan name produces safe stable identifier
- renew requires order/payment
- extend requires order/payment
- fake upgrade action removed/hidden

## STATE

Record Telegram callbacks migrated, UI actions hidden/changed, and test results.

## Stop condition

Do not start runtime operation stubs in this session.
