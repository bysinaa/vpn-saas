# Phase 1 — Audit + Ponytail Cleanup

## Goal

Map the real purchase/payment/subscription/provisioning execution graph before changing behavior, then remove only proven dead/duplicate paths that would interfere with a canonical lifecycle.

## Inspect real callers

Focus on:

- PlansService / plan admin creation
- OrdersService
- PaymentsService
- AdminFlow payment approve/reject callbacks
- Telegram BuyFlow
- Telegram callback registration
- SubscriptionsService
- VpnService
- PanelsService / XuiPanelClient
- PanelInboundsService
- Prisma Order / Payment / Subscription / VpnUser / panel models
- tests covering payment, orders, VPN, Telegram admin flows

Trace callback strings such as payment approval callbacks to the actual handler.

## Specifically investigate

- duplicated receipt approval/settlement logic outside PaymentsService
- wallet credit during order payment approval
- direct subscription renew/extend DB mutations
- VpnService methods that only log instead of modifying XUI
- duplicate subscription-link builders
- legacy XUI/VPN models or services still present
- Telegram buttons wired to placeholder/fake operations
- sample/demo production seed data affecting real behavior
- disabled plans still visible/purchasable
- slug generation that breaks Persian plan names

## Ponytail cleanup

Do not delete merely because code looks old.

For every legacy/duplicate candidate:
1. find executable callers;
2. determine canonical replacement;
3. migrate callers;
4. update tests;
5. delete only when no live caller remains.

Do not rewrite XuiPanelClient if its existing tested implementation is valid.

## Deliverable

Update `PAYMENT-PROVISIONING-STATE.md` with:

- canonical call graph
- duplicate settlement/provisioning paths
- fake/stub operations
- legacy candidates and whether they are safe to remove
- files changed/removed
- tests run

## Stop condition

Do not start Phase 2 in this Codex session.
