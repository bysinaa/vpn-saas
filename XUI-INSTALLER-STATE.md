# XUI Installer State

Executable code is the source of truth. Keep this factual and concise.

## Current phase

Phase 5 COMPLETE. XUI installer execution plan complete.

## Verified architecture

- Supported launcher: `scripts/install.sh` -> `cli/dist-cli/index.js install` -> `cli/commands/install.3xui.ts`.
- The production `InstallCommand` now invokes `createXuiRuntimeDetector().discover()` before any 3x-ui installation or credential prompt. An existing runtime is reused from authoritative discovery; the legacy free-port guesses and TLS/panel-URL prompts are no longer executable in this path.
- `cli/installer/xui-runtime-detector.js` is the sole read-only 3x-ui discovery implementation; `cli/installer/xui-detector.js` is auth-only (CSRF/session login plus authenticated inbounds probe).
- Discovery preserves separate panel and subscription hosts, schemes, ports, and paths, prefers configured domains over fallback public IPs, is read-only, and never reports CONNECTED.
- `PanelInstallerService` is the installer-to-runtime bridge. It upserts the canonical XUI `VpnPanel`, encrypts `username:password` into `VpnPanel.apiKey`, and ensures one associated `Server` on rerun.
- `PanelInboundsService.syncPanelInbounds` remains the sole inbound reconciler. It updates safe inbound inventory fields, retains operator exclusions, and marks missing inbounds unavailable.

## Production install behavior

- If 3x-ui is absent, `InstallCommand` runs the upstream installer and then performs canonical discovery; it does not invent endpoint settings. If discovery still lacks authoritative panel or subscription endpoints, installation stops.
- A discovered username is reused. Only a missing username and the undiscoverable password are requested. Authentication uses the canonical detector, retries rejected credentials, and reports `AUTH_REQUIRED` when credentials are unavailable; validated plaintext exists only in memory until app-context reconciliation.
- `.tazaxy/config.json` receives sanitized endpoint metadata only. `XUI_PANEL_PASSWORD` is empty in generated bootstrap env; the encrypted `VpnPanel.apiKey` remains the runtime credential store.
- PostgreSQL setup now uses `postgres-detector` plus `db-route-resolver`. Native PostgreSQL is provisioned through the scoped, idempotent `postgres-provisioner` and is addressed from the app container through `host.docker.internal`, never the nonexistent Compose host `postgres`. A previously generated TAZAXY database credential is reused; a legacy URL targeting the panel's `xui` database is not reused.

## Phase 3 behavior

- After migrations, `InstallCommand` runs the Nest-emitted `dist/src/scripts/reconcile-xui.js` in the app container. The validated credential crosses the boundary only on stdin; it never enters `.env`, CLI arguments, or installer state.
- The app-container authenticated inbound list probe validates the actual runtime network path. At least one eligible inbound is required for provisioning-ready status.
- Failures mark the panel `UNHEALTHY`; success marks it `HEALTHY`. No 3x-ui database write is used.
- Bootstrap env is limited to `XUI_PANEL_BASE_URL`, `XUI_PANEL_USERNAME`, `XUI_PANEL_SUB_PORT`, `XUI_PANEL_SUB_PATH`, and `XUI_PANEL_TLS_ENABLED`; `XUI_PANEL_PASSWORD` remains empty because `VpnPanel` is the runtime credential store.

## Phase 4 behavior

- `status` performs one one-shot host discovery and passes only authoritative, non-secret endpoint observations to `dist/src/scripts/reconcile-xui-drift.js` in the app container; it is not a polling daemon.
- The reusable `PanelInstallerService.reconcileXuiDrift` authenticates the observed endpoint with the existing encrypted runtime credential before changing `VpnPanel.baseUrl`, `subPort`, or `subPath`; it records source/timestamp metadata and then uses the canonical inbound synchronizer.
- Endpoint changes require coherent listener evidence. Missing listeners and reliably detected foreign port owners are not auto-applied. Unchanged observations remain idempotent.
- Failed stored authentication marks `healthStatus` `AUTH_REQUIRED` without overwriting credentials or endpoint data. Other validation/sync failures mark the panel unhealthy.

## Phase 5 behavior

- `tazaxy panel diagnose` is the one safe read-only diagnostic. It combines fresh host discovery with an app-container authenticated inbound list using the encrypted `VpnPanel` credential.
- The diagnostic reports installation/DB detection, distinct panel and subscription endpoints/listeners, authentication and API probe, discovered/enabled/eligible inbound counts, persisted `VpnPanel`/`Server`/`InboundConfig` counts, application-context connectivity, and drift/stored health.
- `CONNECTED` requires a successful authenticated app-context inbound probe and at least one eligible inbound. Invalid stored credentials report `AUTH_REQUIRED`; listener or process presence alone never passes.
- Legacy `.tazaxy/config.json` panel writers, standalone fake health/registration paths, and stale CLI bundle modules were removed. CLI bundle copying now deletes runtime modules removed from source.
- Manual XUI probe scripts no longer print CSRF tokens or session-cookie fragments.

## Removed executable paths

- `cli/installer/auto-config.js`
- `cli/installer/installer.js`
- `cli/installer/register-and-record.js`
- `cli/installer/verify-health.js`
- `scripts/register-panel.cjs`
- `scripts/run-installer-smoke.ps1`
- `scripts/run-installer-smoke.sh`

## Tests last run

- `npx jest src/modules/panels/panel-installer.service.spec.ts src/modules/panels/panel-inbounds.service.spec.ts src/modules/panels/xui-panel.client.spec.ts --runInBand` PASS (26 tests).
- `npm run test:installer` PASS (55 tests), including a regression that builds and exercises the supported production install command and proves existing 3x-ui discovery replaces legacy endpoint prompts/port guesses.
- `node --test cli/installer/postgres-provisioner.test.cjs` PASS (11 tests).
- `npm run build` PASS.
- `npm run cli:build` PASS (27 installer modules copied).
- `node --test cli/installer/build-integrity.test.cjs` PASS (8 tests).
- `node cli/dist-cli/index.js help` PASS.
- `node cli/dist-cli/index.js panel diagnose` PASS as a safe degraded local check: Docker 3x-ui detected, host listeners unverified on Windows, TAZAXY app container unavailable, authentication not falsely reported.
- `git diff --check` PASS.

## Real-server acceptance

- On 2026-08-12, a live Linux host was verified after the operator changed the 3x-ui panel to port `8000` and path `/api/`, while subscription remained on `2096/sub/`.
- Diagnosis now builds the app-context candidate from fresh authoritative scheme/port/path discovery while preserving the reachable configured host. It probes that candidate with the encrypted stored credential instead of the stale persisted endpoint.
- `tazaxy panel diagnose` reached `CONNECTED` without supplied plaintext credentials: authentication and inbound API probe passed, application-context connectivity passed, and three eligible inbounds were observed.

## Cloudflare public endpoints (2026-08-12)

- `tazaxy cloudflare` invokes the idempotent `scripts/setup-cloudflare-xui.sh` workflow. It discovers authoritative local panel/subscription origins, asks for the two public HTTPS URLs, reuses or creates a locally-managed tunnel, adds DNS routes, validates ordered ingress, and runs it as a systemd service.
- Internal XUI API coordinates remain unchanged. Public panel/subscription URLs are stored in sanitized runtime metadata; subscription URL generation uses the public subscription override, and existing persisted user/subscription links are migrated transactionally.

## Cloudflare route adoption (2026-08-13)

- The Cloudflare command discovers an active config/process and matches existing panel/subscription ingress by authoritative origin ports. It offers reuse first or editable detected defaults, adopts routes without duplicates, and preserves working origins.
- Public panel URLs retain the XUI web base path. Health updates preserve public endpoint metadata, and usage sync reconciles the real XUI sub ID into tunneled `VpnUser`/`Subscription` delivery links.
- Production adopted `api.mivezone.ir/api/` and `sub.mivezone.ir`; 5/5 mappings and links reconciled, all five subscription probes returned 200, app is healthy, and `cloudflared-tazaxy` is active.

## Cloudflare installer repair (2026-08-14)

- The Cloudflare workflow installs the official `cloudflared` Linux binary when absent, then asks for exactly two explicit HTTPS inputs: the public Panel URL and public Subscription base URL. Zone API discovery and base-domain/subdomain prompts were removed after live-server acceptance showed they did not match the operator workflow.
- The public Panel URL preserves an explicitly supplied path or receives the authoritative discovered XUI panel path; the Subscription input is normalized to its HTTPS origin. Existing matching ingress routes remain adoptable and idempotent.
- `npm run test:installer` PASS (89 passed, one Docker-daemon-dependent test skipped on Windows); Bash syntax, `npm run build`, `npm run cli:build`, and `git diff --check` PASS.
