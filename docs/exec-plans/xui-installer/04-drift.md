# Phase 4 — Drift Detection + Reconciliation

## Goal

Detect later 3x-ui changes that can break TAZAXY without turning the CLI into a permanent uncontrolled polling daemon.

## Drift that matters

Detect relevant changes including:

- panel port/path
- subscription port/path
- TLS/domain configuration used by TAZAXY
- panel listener/process availability
- port ownership conflict when reliably detectable
- inbound added/removed/disabled/port changed
- authentication/session no longer valid
- database/runtime location changes that affect future discovery
- application-container connectivity failure

## Invocation strategy

Build one reusable health/reconcile operation.

Invoke it automatically from relevant existing commands such as:

- install
- status
- panel status/diagnose
- update
- start/restart commands if present

Do not create an infinite polling loop inside the CLI.

If the Nest application already has a suitable lightweight scheduler mechanism, a small periodic XUI health reconciliation is allowed. Do not introduce BullMQ/Redis queues for this.

## Classification

### Safe auto-sync
Examples:
- inbound metadata changed
- enabled inbound added
- inbound removed/disabled
- version/health metadata changed

Use canonical inbound synchronization.

### Connectivity configuration drift
Examples:
- authoritative panel port/path changed
- authoritative subscription port/path changed
- relevant TLS/domain changed

Only auto-update TAZAXY when:
1. the new value comes from an authoritative source;
2. listener/runtime evidence is coherent;
3. validation with the new value succeeds.

Record the reconciliation result.

### Authentication drift
If stored credentials stop authenticating:
- do not overwrite/reset them;
- mark AUTH_REQUIRED/unhealthy appropriately;
- retain newly rediscovered non-secret endpoint data;
- tell CLI user how to re-authenticate.

## Port conflict semantics

Distinguish:
- intended configured port changed;
- configured listener is down;
- port is owned by another process;
- reverse-proxy/public endpoint arrangement.

Authoritative config says what should happen.
`ss` says what is currently bound.
Authenticated HTTP/API says what is usable.

Never rewrite configuration from listener heuristics alone.

## Cache/state

If installer state caches discovery:
- cache is not source of truth;
- include observed timestamp/source;
- use a sensible short TTL for volatile health/auth facts;
- real runtime validation wins over cache.

## Tests

Cover at least:

- panel port changes and new authoritative endpoint validates
- subscription port/path changes
- missing listener
- conflicting port owner where testable
- password changes -> AUTH_REQUIRED, no automatic overwrite
- inbound added/removed/disabled/port changed
- stale cached health contradicted by runtime
- repeated reconciliation is idempotent

## STATE

Record exact drift policy, invocation points, auto-reconciled fields, fields requiring user auth/action, and test results.
