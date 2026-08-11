# Phase 3 — Subscription + XUI Provisioning

## Goal

After canonical order settlement, create/renew the subscription and ensure exactly one correct XUI client using the purchased plan.

## Subscription source values

Use canonical plan/subscription values:

- traffic limit bytes
- duration days / expiresAt
- device/IP limit
- provisioning panel
- provisioning inbound snapshot

Do not use hardcoded package values.

## XUI identity

Use recognizable stable naming:

Preferred:
`tg_<sanitizedTelegramUsername>_<telegramId>`

Fallback:
`tg_<telegramId>`

Requirements:
- sanitize to XUI-safe format
- deterministic enough for support/operations
- Telegram ID remains included because username can change or be absent
- avoid random-only names for normal provisioning
- do not expose secrets in the name

If schema/runtime supports comments/metadata, keep username/Telegram identity there too without duplicating secrets.

## Exactly one logical client

A subscription attached to multiple eligible inbounds must still represent one logical XUI client/user.

Traffic quota is shared and must not be multiplied by number of inbounds.

Use the existing inbound snapshot semantics where valid.

## Provisioning idempotency

Handle retries safely.

Before creating a new remote client, check the persisted mapping/remote identity as appropriate.

A repeated post-commit provisioning attempt must not create duplicates.

Persist:
- remote/client identity
- subId/token mapping as currently required
- canonical subscription link
- panel/inbound snapshot
- expiry/quota mapping

## Subscription URL

Create one canonical builder/service.

It must honor the actual:
- subscription scheme/host
- configured subPort
- configured subPath
- subId/token

Remove duplicated URL construction after migrating callers.

No code path may build `/sub/...` while ignoring configured subscription port/path.

## Provisioning failure

Do not falsely report purchase delivery success.

Persist a recoverable provisioning state/error according to existing architecture.

Retries must be safe.

Do not roll back a legitimately confirmed external payment merely because XUI is temporarily unreachable.

## Tests

Cover:

- plan 30 GB -> XUI 30 GB
- duration -> expected expiry
- device limit mapped
- username naming + no-username fallback
- Telegram ID metadata
- exact inbound IDs attached
- multi-inbound does not multiply quota
- repeated provisioning creates no duplicate client
- subscription URL honors custom port/path
- provisioning failure remains recoverable
- no secret/link leakage in logs

## STATE

Record final provisioning entry point, client identity scheme, URL builder, idempotency strategy, and tests.

## Stop condition

Do not start Telegram lifecycle work in this session.
