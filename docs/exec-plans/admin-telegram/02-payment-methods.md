# Phase 2 — Payment Methods Management in Telegram

## Goal
Allow admins to manage real payment configuration from Telegram using existing canonical services/models.

## UX
Use inline keyboards + existing admin authorization.
Prefer list → select → action.
Every section: Back, Home/Admin menu, actionable empty state, masked sensitive data, success/error feedback.

## Bank cards
Using existing service/model, support:
- list
- add
- edit
- enable/disable
- set default
- remove safely

Show users only active/default cards according to purchase-flow semantics.
Do not invent a second schema.
If hard delete is unsafe for history, use existing disable/archive semantics.

## Crypto
Using existing crypto configuration, support:
- list
- add
- edit
- enable/disable where supported
- safe remove

Show required network/currency/address info. Never implement wallet generation/custody.

## Payment gateways
Inspect current provider architecture first.
Manage only fields runtime actually consumes:
- enabled/disabled
- merchant/account identifier
- provider-specific non-secret settings
- secret/API credential update where supported

Never echo stored secret plaintext.
Display masked/configured status.
If config lives in Settings, use canonical Settings service.

## Architecture
Reuse existing Telegram/admin state-machine pattern.
UI/state collection in flow; validation/business mutation in services.

## Tests
Cover admin authorization, card CRUD/default/state, crypto CRUD, gateway configure/enable/update, masking, Back/Home, empty states, and service delegation.

## STATE
Record canonical service/model for each section and tests.

## Stop
Do not start Phase 3.
