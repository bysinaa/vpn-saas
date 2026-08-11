# XUI Installer Refactor — Index

## Goal

A TAZAXY installation on a Linux server with an existing 3x-ui installation must be able to:

1. discover the real 3x-ui installation and database safely;
2. distinguish panel, subscription, and inbound configuration;
3. authenticate using the real supported mechanism;
4. validate actual runtime listeners and application-context connectivity;
5. reconcile TAZAXY `VpnPanel`, `Server`, and `InboundConfig`;
6. detect later configuration drift that can break TAZAXY;
7. stay simple, idempotent, secure, and testable.

## Phases

1. `01-cleanup.md`
   Audit installer/CLI/scripts and perform evidence-based Ponytail cleanup.

2. `02-discovery.md`
   Build one canonical normalized 3x-ui discovery implementation.

3. `03-auth-reconcile.md`
   Authenticate and reconcile discovery into TAZAXY runtime state.

4. `04-drift.md`
   Detect and safely reconcile connectivity-affecting drift.

5. `05-verify.md`
   Finish integration diagnostics, regression tests, and acceptance checks.

## Global invariants

- `panelPort != subscriptionPort != inboundPort` conceptually, even when numeric values happen to match.
- `webBasePath != subscriptionPath` conceptually.
- configured != listening.
- listening != authenticated.
- authenticated API + authenticated inbound probe are required for CONNECTED.
- local 3x-ui database access is discovery-only and read-only.
- do not invent/recover plaintext credentials from hashes.
- do not silently reset 3x-ui credentials.
- do not mutate production configuration from weak heuristics.
- authoritative configuration identifies intended settings; listener inspection identifies runtime state; authenticated API validates usability.
- Docker/container topology matters: a host-side curl does not prove the app container can connect.
- no duplicate XUI detectors, config writers, or runtime credential stores.
- do not work on payment/business logic in this execution plan.

## Persistent state

Every phase must update:
`XUI-INSTALLER-STATE.md`

Keep STATE concise. Record verified facts and decisions, not raw investigation logs.
