# Phase 3 — Authentication + TAZAXY Reconciliation

## Goal

Turn successful 3x-ui discovery into a validated TAZAXY runtime connection and synchronize the runtime database idempotently.

## Authentication

Verify current upstream 3x-ui behavior from source before changing the client.

Use the actual supported authentication mechanism.

For session/CSRF auth, validation must include:

1. required bootstrap/CSRF request;
2. login;
3. treat HTTP 200 + `success:false` as failure;
4. preserve required cookies/session state;
5. authenticated API probe;
6. authenticated inbound list probe.

Only then may status become CONNECTED.

If valid stored credentials exist, reuse them.

If credentials are not recoverable/discoverable:
- retain all non-secret discovery data;
- return AUTH_REQUIRED;
- interactive CLI may request credentials once;
- validate immediately;
- store via the existing encrypted TAZAXY mechanism.

Never silently reset/change 3x-ui credentials.

## Runtime configuration responsibilities

Keep storage simple:

- `.env`: bootstrap/infrastructure values actually consumed by runtime.
- `VpnPanel`: canonical persisted runtime panel connection/config.
- associated `Server`: canonical server binding required by current application architecture.
- `InboundConfig`: synchronized authenticated inbound inventory.

Do not introduce a third credential store.

Audit env writer -> env validator -> runtime consumer mappings. Remove obsolete XUI env variables only after proving no active consumer.

## Reconciliation

After discovery/auth:

1. normalize endpoint configuration;
2. validate listener state;
3. authenticate;
4. fetch inbounds;
5. write/update only required bootstrap env values;
6. ensure migrations/app DB are ready;
7. upsert the canonical `VpnPanel`;
8. upsert/reconcile its `Server`;
9. run canonical inbound synchronization;
10. require at least one eligible inbound for provisioning-ready status;
11. validate panel reachability from the application's actual network context.

Re-running must not duplicate panel/server rows.

Do not write directly to 3x-ui DB.

## Inbound synchronization

Use the existing canonical panel/inbound service where valid.

Synchronize real:
- inbound id
- enabled/remote state
- protocol
- port
- remark/tag where relevant
- provisioning/client compatibility flags

Do not persist complete sensitive inbound settings unnecessarily.

## Application network topology

A successful request from the host is insufficient if Nest runs in Docker.

Reuse topology-aware logic: validate from the same network context the application uses where feasible.

## CLI state examples

- FOUND: installation discovered, auth not yet established.
- AUTH_REQUIRED: endpoint/listeners exist but stored/provided auth fails or is unavailable.
- CONNECTED: authenticated API + inbound probe + app-context connectivity succeed.
- UNHEALTHY: previously configured runtime connection currently fails.

Use existing status enums if suitable; do not duplicate enums merely to match names above.

## Tests

Cover:

- valid auth -> CONNECTED
- HTTP 200 + success:false -> AUTH_REQUIRED
- session/CSRF preservation
- inbound probe required for CONNECTED
- idempotent VpnPanel/Server reconciliation
- inbound add/remove/disable reconciliation
- host succeeds but app-container context fails -> not healthy/connected for app runtime
- secrets absent from logs/state

## STATE

Record exact canonical runtime storage, env mappings changed, auth behavior, DB reconciliation behavior, and tests.

## Stop condition

Do not implement ongoing drift monitoring until this phase is stable.
