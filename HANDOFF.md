# HANDOFF

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
