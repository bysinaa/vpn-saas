# Phase 2 — Canonical 3x-ui Discovery

## Goal

Build one normalized discovery implementation for the existing 3x-ui installation. Discovery must not require successful authentication to return non-secret installation facts.

## Sources

Use authoritative sources and cross-check them where useful:

1. currently stored TAZAXY values, only after validation;
2. current 3x-ui CLI/binary behavior;
3. service/runtime environment;
4. 3x-ui database in read-only mode;
5. systemd;
6. process/listener inspection (`ss` preferred);
7. Docker/container metadata when applicable.

Known paths may be candidates, never the only truth.

If `sqlite3` CLI is absent, use a safe Python stdlib sqlite fallback rather than adding a package solely for discovery.

## Discover separately

### Installation
- native/docker/unknown
- service/binary
- version if reliably obtainable
- DB backend and DB path/DSN metadata

### Panel
- scheme
- host/bind/domain context
- panel web port
- web base path
- TLS state/cert metadata when useful

### Subscription
- scheme
- subscription host/domain context
- subscription port
- subscription path
- relevant TLS metadata

### Runtime listeners
Capture actual TCP/UDP listeners and ownership when reliable.

### Authentication capability
Determine the current upstream auth mechanism and whether credentials are already available from a legitimate authoritative source.

Never derive plaintext passwords from hashes.

## Normalized result

Create one typed/validated result model containing at least:

- overall discovery status
- installation
- panel
- subscription
- authentication capability/state
- database
- listeners
- diagnostics

Authenticated inbound inventory may be populated later in Phase 3.

Do not create parallel result shapes for different detectors.

## Required diagnostics

Support clear conditions such as:

- XUI_NOT_FOUND
- PANEL_PORT_NOT_LISTENING
- SUBSCRIPTION_PORT_NOT_LISTENING
- PORT_OWNED_BY_DIFFERENT_PROCESS when reliable
- AUTH_REQUIRED when discovery succeeded but auth cannot be validated

Do not infer a new intended port solely from `ss`.

## Critical regression

Explicitly test distinct values such as:

- panel port `2053`
- subscription port `2096`
- panel path `/abc/`
- subscription path `/sub/`

They must remain distinct.

## Tests

Cover at least:

- native install
- Docker install where existing test harness permits
- sqlite3 unavailable -> Python fallback
- separate panel/subscription ports and paths
- configured listener missing
- no credentials available -> discovery still succeeds with AUTH_REQUIRED/non-auth state
- malformed/partial settings degrade with diagnostics instead of false CONNECTED

## STATE

Update `XUI-INSTALLER-STATE.md` with the canonical detector/result type, authoritative sources used, tests, and remaining auth work.

## Stop condition

Do not start DB reconciliation or business logic in this phase.
