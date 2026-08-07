# HANDOFF

## Installer Fix: Wrong Repository Clone & Missing package.json Guard

### Problem

`scripts/install.sh` cloned `https://github.com/bysinaa/tazaxy.git` — a repository that does not contain `package.json`.  The `build_cli()` function then ran `npm install` in the install directory, which failed with ENOENT because `package.json` was missing.  No validation existed before the `npm` invocation.

### Changes (only `scripts/install.sh` was touched)

1. **REPO_URL default** changed from `tazaxy.git` to `vpn-saas.git` (line 4).
2. **install directory guard** added before any npm work — if `$INSTALL_DIR` does not exist `build_cli` prints a clear error including `$REPO_URL` and exits 1.
3. **package.json guard** added — if `$INSTALL_DIR/package.json` is missing, prints the expected repository name (`vpn-saas`), the fix instructions, and exits 1.
4. **`cd` ordered after guards** so the script never emits a raw `cd:` shell error.
5. **`npm ci` preferred** when `package-lock.json` exists (reproducible install); falls back to `npm install`.

### Tests — Linux (Alpine container, bash 5.3 + git 2.54 + Node 24)

Final run: **14 assertions passed, 0 failed.**

| # | Test | Result |
|---|------|--------|
| 1 | `bash -n` syntax check | PASS |
| 2 | default REPO_URL = `vpn-saas.git`; no stale `tazaxy.git` anywhere in the script | PASS |
| 3a | dir exists but has no `package.json` (reproduces the reported bug) → clear error, exit 1, npm never invoked, no ENOENT | PASS |
| 3b | install dir absent entirely → clear error, exit 1, no raw `cd:` shell error leaked | PASS |
| 4 | end-to-end `install_or_update_repo` → `npm ci` → `npm run cli:build`, exit 0; `cli/dist-cli/index.js` produced | PASS |
| 5 | `node cli/dist-cli/index.js help` on the built tree, exit 0 (prints `Tazaxy CLI v2.0.0`) | PASS |

Test 4 clones from a local bare repo seeded with `package.json`, `package-lock.json`, `tsconfig.json` and `cli/`, standing in for `vpn-saas.git`; it exercised the `npm ci` branch since the lockfile is present.

### Commands Tested

```bash
# Full harness. npm retry settings are needed only because the Docker bridge
# on this host intermittently resets connections to the npm registry.
docker run --rm \
  -v "C:/Users/TAZA/Desktop/vpn-saas:/repo:ro" \
  -v "C:/Users/TAZA/AppData/Local/Temp/tazaxy-install-test:/test:ro" \
  -w /tmp alpine:latest \
  sh -c "apk add --no-cache bash git nodejs npm >/dev/null 2>&1; \
         npm config set fetch-retries 8; \
         npm config set fetch-retry-maxtimeout 120000; \
         npm config set fetch-timeout 300000; \
         bash /test/test-installer.sh"
# => PASSED: 14   FAILED: 0

# Lightweight check (syntax + stale-reference scan)
docker run --rm -v "C:/Users/TAZA/Desktop/vpn-saas/scripts:/scripts:ro" alpine:latest \
  sh -c "apk add --no-cache bash >/dev/null 2>&1; bash -n /scripts/install.sh \
         && grep -q 'vpn-saas.git' /scripts/install.sh \
         && ! grep -q 'tazaxy.git' /scripts/install.sh && echo PASS"
```

Notes on the test environment, so the next person does not chase ghosts:

- Do **not** pass `--network host` to these containers; it breaks DNS in Docker Desktop's Linux VM and `apk add` then fails with `sh: bash: not found`.
- An earlier run of test 4 failed with `npm error code ECONNRESET`. That was registry flakiness on the Docker bridge, not an installer defect; the npm retry settings above make it reliable.

### Not Verified Here

`install_base_dependencies`, `install_launcher`, `run_cli_installer` and `show_management_menu` were not executed: they require root, mutate `/usr/local/bin`, install system packages, or need interactive input plus a live database and 3X-UI panel. Only the clone/npm/build path in the reported failure was exercised.

### No Other Files Changed

Only `scripts/install.sh` was modified. A repo-wide search confirms no remaining `tazaxy.git` reference. The harness lives in `%TEMP%` and is not committed.

## Installer Integration Checkpoint

### Current Goal

Route the legacy panel command and install wizard through the XUI detector/credential boundary while preserving retained VPN E2E fixtures.

### Completed

1. Replaced legacy `detect-xui.js` discovery with a thin compatibility adapter over read-only `xui-detector.js`.
2. Added instance-isolated runtime injection for subprocesses, filesystem/SQLite, HTTP(S), clock, and optional state hooks.
3. Added `xui-credential-validator.js`: hidden-input-compatible validation, encrypted-credential reuse, explicitly authorized SQLite import, and redacted results.
4. Added `installer-adapter.js`: sanitized, idempotent detection persistence plus encrypted panel-registration/binding/sync hooks.
5. Added unified read-only `postgres-detector.js`; routed `detect-db.js`, CLI infrastructure detection, auto-config discovery, and `DatabaseManager.discover()` to it.
6. Removed visible XUI password CLI options (`--password`, `--pass`, `--panel-pass`) and enabled TLS verification in `PanelCommand`.
7. Removed dead legacy PostgreSQL Docker/volume discovery code and corrected the retained XUI client fixture to its documented `string[]` link contract.
8. Panel authentication now delegates to `XuiCredentialValidator`; direct legacy login/HTTP and plaintext panel-env persistence were removed from `PanelCommand`.
9. Install wizard validates XUI credentials through `XuiCredentialValidator` and no longer writes the panel password to runtime state or generated environment output.
10. Runtime installer state strips panel passwords, tokens and token-expiry fields before writing.

### Module Boundaries

- `xui-detector.js`: discovery/scoring only; never writes state or authenticates.
- `xui-credential-validator.js`: read-only login/health validation; credentials never appear in results.
- `postgres-detector.js`: sanitized Docker/Compose/native/process/WSL/config discovery with `pg_isready`.
- `installer-adapter.js`: intentional sanitized state persistence and encrypted registration orchestration hooks.

### Fixture Coverage

`cli/installer/installer-detectors.test.cjs` has 12 injected-fixture tests covering Docker, Compose/systemd/process/WSL, custom path/port SQLite metadata redaction, timeout/wrong/malformed responses, TLS/insecure behavior, credential-validation persistence boundaries, binding/sync hooks, PostgreSQL readiness/auth failures, and redaction.

### Commands Actually Run

- `node --test cli/installer/installer-detectors.test.cjs` — 12/12 passed, exit 0.
- `npm.cmd run cli:build` — exit 0.
- `node cli/dist-cli/index.js help`, `node cli/installer/detect-xui.js --help`, `node cli/installer/detect-db.js --help` — exit 0.
- `npm.cmd test -- src/modules/panels/xui-panel.client.spec.ts --runInBand` — 1 suite / 10 tests passed, exit 0.
- `npm.cmd test -- --runInBand` — 9 suites / 34 tests passed, exit 0.
- `./node_modules/.bin/tsc.cmd --noEmit` — exit 0.
- `git diff --check` — exit 0.

### Ponytail Lite

Removed unreachable duplicate PostgreSQL discovery helpers from `src/database/database-manager.js`; no dependency was added.

### Verification This Checkpoint

- `node --test cli/installer/installer-detectors.test.cjs`: 12/12 passed, exit 0.
- `npm.cmd run cli:build`: exit 0.
- `npm.cmd test -- --runInBand`: 9 suites / 34 tests passed, exit 0.
- `node cli/dist-cli/index.js help`: exit 0.
- `node --check cli/installer/detect-xui.js`: exit 0.
- `tsc --noEmit`: exit 0; `git diff --check`: exit 0.

### Remaining Legacy / Next Checkpoint

Interactive callers now validate through `XuiCredentialValidator` and sanitize runtime state, but production database registration through `InstallerAdapter` is not wired into the interactive commands. No isolated installer database/schema was proven in this read-only checkpoint, so no real installer, panel, Docker or database mutation was attempted. Retained VPN E2E fixtures were untouched.

## Payment Admin Controls Checkpoint

### Changes

- Added card-number normalization, Luhn validation, masking helpers, active/default controls, and soft-disable deletion in `BankCardsService`.
- Added role-checked Telegram card callbacks for toggle/default/disable actions; card numbers are masked in admin listings.
- Preserved the atomic receipt approval path and existing receipt callback authorization.
- Added focused bank-card administration tests.

### Tests

- `npm.cmd test -- src/modules/payments/bank-cards.service.spec.ts --runInBand`: 1 suite / 3 tests passed, exit 0.
- `npm.cmd test -- --runInBand`: 10 suites / 37 tests passed, exit 0.
- `tsc --noEmit`: exit 0.
- `git diff --check`: exit 0.

### Ponytail Lite

Kept the existing `BankCard` model and callback flow; added only shared validation/masking and bounded admin actions. No migration was required.

### Next Step

Add mandatory-channel membership lock and a one-time 1 GB 30-day gift subscription.

## Zarinpal IRT Checkpoint

### Changes

- Implemented official Zarinpal v4 JSON request and verify endpoints with explicit `currency: "IRT"`; amounts are passed and persisted as integer toman without rial conversion.
- Added sandbox configuration using the official `sandbox.zarinpal.com` host; production always uses `payment.zarinpal.com`.
- Payment records now retain gateway callback status, verification code, and `ref_id`; existing `orderId`, `amount`, and unique `gatewayRef` retain the stored order, exact amount, and Authority.
- Callback handling looks up the stored Authority first. `NOK` is recorded without verification; only `OK` proceeds to verification.
- Verification uses the stored Authority and exact stored toman amount. Codes 100 and 101 both confirm; settlement claims the payment atomically so order completion, wallet credit, subscription and provisioning run once.
- Gateway responses, merchant ID, Authority, card hash and callback payloads are not logged or returned in payment DTOs.
- Added bounded 10-second transport handling: initiation is never retried; idempotent verify retries once only after transport failure.

### Tests

- `npm.cmd test -- src/modules/payments/gateways/default-zarinpal.gateway.spec.ts src/modules/payments/payments.service.spec.ts --runInBand`: 2 suites / 8 tests passed, exit 0.
- `npm.cmd test -- --runInBand`: 12 suites / 45 tests passed, exit 0.
- `./node_modules/.bin/tsc.cmd --noEmit`: exit 0.
- `git diff --check`: exit 0.

### Ponytail Lite

Removed the unused configurable online-gateway base URL. The gateway now selects only official production or sandbox Zarinpal origins.

### Next Step

Add mandatory-channel membership lock and a one-time 1 GB 30-day gift subscription.


---

## Session: real-panel verification of 3x-ui auto-discovery (2026-08-04)

Test target: `91.107.249.248` (root/SSH). Real panel: **3x-ui v3.6.0**, port **17342**,
web base path **/MTYFUStdaiG35FGCaU/**, TLS enabled, default creds still in place.

### What was verified end-to-end against the live panel

| Item | Result |
| --- | --- |
| Auto-discovery (`xui-detector.js`) | **FOUND @ 70%** with the correct URL incl. `webBasePath` |
| DB read fallback chain (sqlite3 -> python3 -> binary scan) | Works; the box has **no sqlite3 CLI**, so the python3 fallback is the one that actually runs |
| `xui-credential-validator.js` correct password | **FOUND** / `CREDENTIALS_VALIDATED` |
| `xui-credential-validator.js` wrong password | **ERROR** / `AUTH_FAILED` (correctly rejected) |
| Unit suite `installer-detectors.test.cjs` | **13/13 pass** |

### Bug found and fixed during this session

3x-ui v3.6.0 requires a CSRF token on unsafe methods: you must `GET /csrf-token` and echo
the value back as the `X-CSRF-Token` header (carrying the session cookie) or `POST /login`
returns **403**. The validator did not do this, so it rejected *correct* credentials.
Fixed in `cli/installer/xui-credential-validator.js`.

Two related traps this panel sets, both now covered by tests:

1. A **failed** login returns **HTTP 200** with `{"success":false}`. Checking only the status
   code accepts a wrong password. The validator must parse the JSON body.
2. The login page is served at the **web base path root**, not at `/login`; probing `/login`
   returns 404 and made discovery look like a miss.

The old test fixtures returned a bare `{statusCode:200}` for every request, which could not
catch either trap. They were replaced with a `xuiPanelFixture()` that emulates the real
panel (CSRF required, 200 + `success:false` on bad password), plus a regression test.
**Verified non-vacuous:** the new test fails against the pre-fix validator and passes after.

### Installer state

`installer-state.json` held a stale `127.0.0.1:2053` binding (`detections.xui` =
`PARTIAL`, plus an expired `xui.autoConfig` pinned to `change-me`). Cleared with the
project's own `purgeStale()` API; `xui.confirmed` / `xui.autoConfig` were dropped so the
next run re-discovers. Note the local Windows box genuinely does run a separate 3x-ui
container on 2053, so that entry was stale, not fabricated. Revert with
`git checkout installer-state.json` if needed.

### Commands actually run

```bash
# unit suite
node --test cli/installer/installer-detectors.test.cjs

# discovery + validator against the real panel (executed on the remote host)
plink -ssh root@91.107.249.248 "cd /tmp/xui-e2e && node xui-e2e.js"
plink -ssh root@91.107.249.248 "cd /tmp/xui-e2e && node xui-validator-probe.js"

# state cleanup
node -e "const sm=require('./cli/installer/state-manager.js'); const s=sm.loadState('installer-state.json'); sm.purgeStale(s); sm.saveState('installer-state.json',s);"
```

### Still open

- The panel still has **default credentials** — rotate before this is treated as production.
- Discovery caps at 70% confidence; it never reaches 100% without a successful authenticated
  call, which discovery deliberately does not perform.

---

## State-driven installer redesign

The installer is no longer a sequence of prompts with patches bolted on. It is a single
automatic flow: **detect everything first, then ask only for what cannot be detected.**

### Modules

| File | Responsibility |
| --- | --- |
| `cli/installer/detection-states.js` | The six states and the `result()` helper every detector returns. |
| `cli/installer/environment-detector.js` | OS/arch/root, Docker + Compose, prior Tazaxy install, PostgreSQL, app/Redis/MinIO containers, `.env`. |
| `cli/installer/xui-runtime-detector.js` | Reads `x-ui.service`, `x-ui setting -show true`, listening ports and `/etc/x-ui/x-ui.db`; then CSRF → login → authenticated API probe. |
| `cli/installer/telegram-detector.js` | Validates `TELEGRAM_BOT_TOKEN` against `getMe`. |
| `cli/installer/clean-install.js` | Backs up `.env` + state, then removes **only** Tazaxy-owned resources. |
| `cli/installer/installation-flow.js` | Orders the ten steps and owns failure/recovery reporting. |
| `cli/installer/menu-navigator.js` | Menu stack with Back / Retry / Refresh on every submenu. |
| `cli/installer/cli-version.js` | `--version` handling, isolated from all command modules. |

### States

`NOT_FOUND · DETECTED · NEEDS_CREDENTIALS · CONFIGURED · CONNECTED · FAILED`

`CONNECTED` is reachable **only** after a successful login *and* an authenticated API call.
A running service, an open port or a value left in `installer-state.json` can raise a component
to `DETECTED` at most — never to `CONFIGURED` and never to `CONNECTED`. Stale state is
re-validated rather than trusted, which is why a saved-but-revoked bot token now reports
`NEEDS_CREDENTIALS` instead of `configured`.

### Existing 3X-UI is reused, never rebuilt

Discovery is strictly read-only. The detector never installs a panel, never writes a setting and
never touches a port; TLS, port and base path are read, not asked. `Preparing 3X-UI runtime` is
skipped entirely once a healthy panel is found, and port `2096` is reported but never
renegotiated. Login handles CSRF tokens, the session cookie and 3X-UI's habit of answering a
rejected login with HTTP 200 + `success:false`. If the username or password cannot be recovered
from the panel database, the flow shows `NEEDS_CREDENTIALS`, asks for them, retries on rejection,
and refreshes CLI status the moment they are accepted — without failing the installation.

### Installation order

```
preflight → detection summary → optional safe cleanup → clone/build launcher →
infrastructure → 3X-UI discovery/authentication → Telegram Bot →
environment generation → service startup → final health verification
```

`STEPS` in `installation-flow.js` is the single source of this order and is asserted by test.

### Safe clean install

`.env` and `installer-state.json` are backed up first. Removal is limited to Tazaxy paths, the
launcher, Tazaxy services, `tazaxy-*` containers, `tazaxy_*` networks and volumes carrying
`com.tazaxy.managed=true`. A protected-path guard refuses `/etc/x-ui` and
`/etc/x-ui/x-ui.db` even if a caller passes them explicitly, so the panel, unrelated PostgreSQL
databases, unlabelled volumes and third-party containers all survive.

### Commands and results

```powershell
# installer regression suite (17 new tests + 13 pre-existing detector tests)
npm run test:installer
#   tests 30 / pass 30 / fail 0 / cancelled 0

# --version prints only the version and exits 0
npx ts-node cli/index.ts --version
#   1.0.0
#   EXIT_CODE=0

# CLI typecheck
npx tsc -p cli/tsconfig.json --noEmit
#   TSC_EXIT=0
```

Fixtures mirror the acceptance server exactly: 3X-UI v3.6.0, HTTPS port `17342`, base path
`/MTYFUStdaiG35FGCaU/`, subscription port `2096`, database `/etc/x-ui/x-ui.db`. The host is
faked at the `exec` / `fs` / HTTP boundary, so the tests assert what the installer *does not*
do — no panel install, no port rewrite, no printed token, no removal of protected paths — which
plain end-to-end runs cannot prove.

### Two real bugs found and fixed while verifying

1. `cli/commands/install.3xui.ts` required `../../installer/xui-credential-validator`; from
   `cli/commands/` the correct path is `../installer/…`. The module never resolved.
2. Because `cli/index.ts` imported every command eagerly, that broken require made **every**
   invocation fail — including `--version`, which exited 1 with a stack trace. Commands are now
   loaded lazily on dispatch, so `--version` and `help` cannot be taken down by an unrelated
   command module. This is the actual root cause of the `--version` bug, not the formatting of
   the version string.

---

## Acceptance run on the real server (`91.107.249.248`)

Executed against the live host, not a fixture. Helper scripts are committed under
`scripts/acceptance/` so the run is repeatable rather than a one-off paste.

### 1. Survey — what the host actually had

```powershell
plink -ssh root@91.107.249.248 -batch -m scripts/acceptance/01-survey.sh
```

Confirmed exactly the documented acceptance target: 3X-UI **v3.6.0**, HTTPS panel on
**17342**, base path **/MTYFUStdaiG35FGCaU/**, subscription port **2096**, panel database
**/etc/x-ui/x-ui.db**. Two details from this host drove real code changes:

- there is **no `sqlite3` CLI**, so only the `python3` read-only fallback can read settings;
- the settings table has **no `subPort` row at all** — the operator never moved the
  subscription port off the stock default, yet `x-ui` is demonstrably bound to `2096`.

### 2. Safe cleanup — Tazaxy only

```powershell
plink -ssh root@91.107.249.248 -batch -m scripts/acceptance/02-safe-cleanup.sh
```

`.env` and `installer-state.json` were backed up first, then only Tazaxy-owned files, the
launcher, Tazaxy services, `tazaxy-*` containers, `tazaxy_*` networks and volumes labelled
`com.tazaxy.managed=true` were removed. Verified afterwards:

| Preserved | Check | Result |
| --- | --- | --- |
| `/etc/x-ui/x-ui.db` | `sha256sum` before vs. after | **identical** |
| `x-ui.service` | `systemctl is-active` | **active**, never restarted |
| Ports `17342` / `2096` | `ss -ltnp` | **still bound by x-ui** |
| Unrelated Docker resources | `docker ps -a`, `docker volume ls` | **untouched** |

### 3. Bug this run exposed: subscription port reported as `n/a`

Reading the settings table alone, the CLI printed `sub port n/a` on a panel that was plainly
serving subscriptions on `2096`. The panel stores nothing when the default is kept, so
settings-only detection cannot see it.

`xui-runtime-detector.js` now resolves the subscription port from two sources in priority
order — an explicit `subPort` row first, then a **bound** `2096` observed in `ss -ltnp` — and
reports which one answered via `subPortSource` (`settings` | `default-bound` | `unknown`).
`subEnable` follows the same rule instead of staying `undefined`. Detection is still strictly
read-only: nothing is written and the port is reported, never renegotiated.

Four regression tests pin this, driven by the real host's shape (no `sqlite3`, python3
fallback, `2096` bound by `x-ui`):

- stock default is inferred as `2096` / `default-bound`, and the detail line no longer says `n/a`;
- an explicit `subPort` wins over the bound default;
- with `2096` **not** bound, the port is honestly `null` / `unknown` rather than guessed;
- discovery still never reports `CONFIGURED` or `CONNECTED` without authentication.

### Commands and results

```powershell
node --test cli/installer/installer-detectors.test.cjs cli/installer/installation-flow.test.cjs
#   tests 34 / pass 34 / fail 0 / cancelled 0 / skipped 0 / todo 0
```

The 4 subscription-port tests are new; the other 30 are the existing installer suite, still green.
(Superseded below: the suite is now 36/36 after the Telegram reachability fix.)


### Still outstanding

The **one-line clean reinstall** on the server (`clone/build launcher → infrastructure →
3X-UI discovery/authentication → Telegram Bot → environment generation → service startup →
final health verification`) has not been run to completion, because the Telegram step is
mandatory and needs a **real `TELEGRAM_BOT_TOKEN`** to validate against `getMe`. Supplying a
placeholder would make the Telegram stage report `NEEDS_CREDENTIALS` and prove nothing about
the `CONNECTED` path, so it was not faked.

Preconditions for that run are met: the panel is untouched and healthy, the host is clean of
Tazaxy artifacts, and `node --test` is green at 36/36.

---

## Bug found while attempting the Telegram step: a blocked network was reported as a bad token

### What happened

Attempting the mandatory Telegram stage on the acceptance host, `getMe` never completed —
outbound HTTPS to `api.telegram.org` is blocked from that server. The CLI reported
**`NEEDS_CREDENTIALS`** and asked for the token again. That is the wrong diagnosis and the
most expensive kind: the operator re-types a perfectly valid token indefinitely while the
actual fault is the network. The token had never been checked at all.

Root cause: `validateToken()` treated *any* non-`ok` outcome as a rejection. A connection
refusal, a DNS failure, a timeout and a genuine HTTP 401 all landed in the same branch.

### Fix

`cli/installer/telegram-detector.js` now separates *not answered* from *answered "no"*:

| Outcome | State | What the operator is told |
| --- | --- | --- |
| No response (refused / DNS / timeout) | `FAILED` | "the token was not checked" — fix outbound HTTPS, then retry |
| HTTP 5xx from Telegram | `FAILED` | Telegram-side error; retry shortly |
| HTTP 4xx / `ok:false` | `NEEDS_CREDENTIALS` | Verify the token with @BotFather |
| `ok:true` | `CONNECTED` | Shows `@username` |

`NEEDS_CREDENTIALS` now means only one thing: **Telegram itself rejected the token.** The
token is still never printed, never logged and never saved unless `getMe` accepted it.

### Commands and results

```powershell
node --test cli/installer/installer-detectors.test.cjs cli/installer/installation-flow.test.cjs
#   tests 36 / pass 36 / fail 0 / cancelled 0 / skipped 0 / todo 0
#   EXIT=0

# proves the two new tests are non-vacuous: strips the guards and re-checks
node scripts/acceptance/prefix-check.cjs
#   pre-fix unreachable -> NEEDS_CREDENTIALS
#   pre-fix HTTP 502    -> NEEDS_CREDENTIALS
#   OK: without the guards both are misreported, so the tests are non-vacuous.
#   EXIT=0
```

Two tests were added: one pins an unreachable API to `FAILED` with a "token was not checked"
recovery, the other pins HTTP 502 to `FAILED` while keeping a real 401 at `NEEDS_CREDENTIALS`.
Both assert the token never appears in the returned object.

### What this means for the outstanding acceptance run

The `CONNECTED` path still needs a real `TELEGRAM_BOT_TOKEN` **and** a host that can reach
`api.telegram.org`. On `91.107.249.248` the second condition does not hold today, so that
stage cannot be completed there regardless of the token. Before retrying, confirm from the
server itself:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://api.telegram.org
# anything other than a response means the Telegram stage will now correctly say FAILED,
# not NEEDS_CREDENTIALS
```


