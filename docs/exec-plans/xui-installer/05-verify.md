# Phase 5 — Diagnostics + Final Verification

## Goal

Finish the XUI installer integration with a safe diagnostic command and prove the full infrastructure path without touching payment/business logic.

## Diagnostic command

Provide or consolidate one read-only command, preferably equivalent to:

`tazaxy panel diagnose`

It should report concise status for:

- installation detection
- DB detection
- panel endpoint
- subscription endpoint
- intended configuration vs listeners
- authentication
- authenticated API/inbound probe
- inbound discovered/enabled/eligible counts
- VpnPanel/Server/InboundConfig reconciliation
- application-context connectivity
- drift/health state

Never print:
- plaintext passwords
- session cookies
- CSRF tokens
- private keys
- full secret DSNs
- subscription/client secrets

## Remove fake success

Audit CLI/status output.

Do not say configured/connected/healthy based only on:
- service existence
- port existence
- `.env` values
- DB file existence
- cached installer state

CONNECTED must reflect current authenticated usability.

## Real-server verification

When a real Linux + real 3x-ui environment is explicitly available, inspect safe equivalents of:

- `command -v x-ui`
- `systemctl status/cat x-ui`
- process list
- `ss -lntup`
- relevant XUI DB/runtime paths
- supported `x-ui setting` commands
- TAZAXY panel diagnose/status

Detection must not mutate or restart 3x-ui.

Do not claim a real integration test happened unless it actually happened.

## Final regression

Run all relevant:

- focused detector tests
- installer tests
- XUI panel client tests
- panel/inbound tests
- TypeScript typecheck/build
- CLI bundle/build tests
- `git diff --check`

Search again for removed legacy detector/config paths to ensure nothing still calls them.

## Acceptance

Complete only when:

- one canonical XUI discovery implementation remains;
- dead/duplicate installer paths are removed or explicitly justified;
- panel/subscription/inbound ports are never conflated;
- panel/subscription paths are never conflated;
- intended configuration and actual listeners are both checked;
- DB discovery is read-only;
- authenticated API + inbound probe gate CONNECTED;
- invalid credentials result in AUTH_REQUIRED/unhealthy state, never false success;
- env values match real runtime consumers;
- VpnPanel and Server reconciliation is idempotent;
- InboundConfig sync works;
- application network context is validated;
- relevant drift is detected and safely classified;
- no plaintext secrets leak;
- all reported tests genuinely ran.

## Final Codex response

Keep it concrete:

1. files removed
2. files created
3. important files modified
4. architecture before/after
5. final discovery/auth/reconcile flow
6. drift behavior
7. exact tests run + outcomes
8. untested real-world limitations

Update `XUI-INSTALLER-STATE.md` one final time.
