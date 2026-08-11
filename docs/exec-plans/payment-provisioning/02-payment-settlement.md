# Phase 2 — Canonical Payment Settlement

## Goal

All successful order payments converge on one idempotent settlement path.

## Canonical rule

Payment confirmation should flow through one service-level operation, preferably `PaymentsService` or an equivalent canonical domain service.

Telegram/Admin handlers must delegate to it rather than reimplement settlement.

## Critical behavior

For payment tied to an order:

payment confirmed
→ order completed exactly once
→ subscription transaction created/updated
→ post-commit provisioning triggered

Do NOT credit wallet for the purchase amount.

For standalone wallet top-up:

payment confirmed
→ wallet credited exactly once

This is valid only when the payment is genuinely a wallet deposit and has no order settlement semantics.

## Admin card receipt

Replace duplicated AdminFlow settlement logic with calls to the canonical PaymentsService API.

Admin approve/reject callbacks may own UI/authorization only.

They must not independently:
- update payment status
- credit wallet
- complete order
- provision subscription

unless the canonical domain service explicitly delegates those operations back.

## Idempotency

Use DB CAS/state transitions so repeated:

- admin approve click
- payment callback
- gateway callback
- retry
- duplicated Telegram update

cannot:
- double-confirm
- double-credit
- double-complete
- double-provision

Preserve correct Zarinpal 100/101 idempotent semantics if current tests/implementation already cover them.

## Transaction boundary

Inside transaction:
- claim payment/order state
- persist settlement/subscription state

Outside committed transaction:
- perform external XUI/network side effects

Do not hold DB transaction open while calling 3x-ui.

## Tests

At minimum:

- order receipt approval does NOT credit wallet
- standalone wallet top-up credits once
- repeated order receipt approval settles once
- repeated gateway confirmation settles once
- failed/NOK payment never completes order
- payment confirmation failure leaves recoverable state
- Telegram admin callback uses canonical PaymentsService

Rewrite tests that currently encode incorrect wallet-credit behavior.

## STATE

Record canonical settlement entry point and all migrated callers.

## Stop condition

Do not start provisioning refactor in this session.
