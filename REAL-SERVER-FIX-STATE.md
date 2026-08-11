# Real Server Fix State

## Final acceptance — COMPLETE

Status: COMPLETE. Real Linux acceptance authority passed on 2026-08-11.

Real-server preflight (2026-08-11):
- Preserved native `x-ui` and PostgreSQL services were active; XUI listeners were observed on 17342/2096 and unrelated PostgreSQL databases remained present.
- The previously deployed TAZAXY stack was healthy, but `tazaxy panel diagnose` reproduced a packaged-path failure at `/app/dist/scripts/diagnose-xui.js`; the current repository fix uses `/app/dist/src/scripts/diagnose-xui.js`.
- Installer final validation was proven to ignore failed Compose/app checks and could print success without establishing required health.
- Production validation now fails closed unless app/Redis/MinIO/nginx are running and healthy, `/health` and database readiness pass, migrations are current, and the canonical in-container XUI diagnosis is `CONNECTED` with an authenticated API probe.
- Focused production installer regression: 8/8 passed. Final server clean cycles remain pending.
- Cycle 1 failed from a clean TAZAXY state: the installer accepted a `SUPER_ADMIN_PASSWORD` shorter than the application schema permits, causing an app restart loop before health checks. The installer now rejects that input before writing `.env` or starting containers.
- Cycle 2 failed at strict XUI validation: the new gate sent an incomplete diagnostic observation, and the generic command timeout left the descendant `docker compose exec` process running. The gate now uses the canonical observation contract and parses the final JSON result; Linux timeouts terminate the full spawned process group.
- Cycle 3 clean installation passed the strict installer gate and post-install wallet/XUI/storage smokes, but final CLI consistency failed: `status` matched `inactive` as `active` for a host-side Redis probe and counted informational listener occupancy as a failed required check. Redis is now probed in its Compose container with an exact `PONG`, and listener occupancy no longer lowers required-health totals.
- Cycle 4 clean installation passed installer, wallet, XUI, storage, and CLI checks, but the installer reconciliation/diagnostic Nest contexts started competing Telegram polling sessions; the main app then stopped on Telegram 409 while HTTP health remained green. All XUI CLI scripts now mark their application context explicitly, and `TelegramBotService` skips bot initialization in that context.
- Cycle 5 was the final untouched clean installation. The supported `scripts/install.sh` entrypoint deployed commit `111ec58`, preserved native XUI/PostgreSQL and unrelated databases, and passed its strict final gate without manual intervention.

Final real-server evidence:
- App, Redis, MinIO, and nginx are healthy with zero restarts; `/health/ready` reports database and Redis up.
- PostgreSQL authenticated from application context as `tazaxy` to database `tazaxy` through `172.28.0.1`; all 9 migrations are applied.
- `tazaxy status` reports 6/6 required checks passing. `tazaxy panel diagnose` reports authenticated API/inbound PASS, one eligible inbound, canonical `VpnPanel`/`Server`/`InboundConfig`, application-context PASS, and `CONNECTED`.
- Real wallet smoke debited once, confirmed one payment, completed one order, provisioned an active XUI subscription, and rejected a duplicate retry without a second debit/settlement.
- Real MinIO smoke authenticated, bootstrapped the private bucket, uploaded a receipt, returned a signed URL retrieved externally with HTTP 200 and matching content, deleted the object, and confirmed no public bucket policy.
- Telegram direct connectivity and long polling started once; no 409 conflict or production error remained after installer/diagnostic execution.
- Five clean install cycles were executed. Cycle 1 found password prevalidation, Cycle 2 found diagnostic payload/timeout handling, Cycle 3 found CLI status inconsistency, Cycle 4 found competing Telegram polling, and Cycle 5 passed end to end.

Final local verification:
- `npm run test:installer`: 79/79 passed.
- PostgreSQL provisioner + build-integrity: 26/26 passed.
- Payments: 21/21 passed, including the real PostgreSQL UUID-lock regression.
- Telegram, storage, panel, and VPN focused suites: 64/64 passed.
- `npm run cli:build`, `npm run build`, and `git diff --check`: passed.

Remaining limitation:
- UFW still contains one pre-existing unmarked rule for an obsolete Docker bridge. It is preserved because it has no TAZAXY ownership comment; the installer neither trusts it as current nor deletes an unproven unrelated rule. The current bridge has the canonical `tazaxy-postgres` scoped rule.

## Session 1 — Installer PostgreSQL / Docker / UFW

Verified facts:
- Installer now creates `tazaxy-network` before native PostgreSQL provisioning, then reads its actual IPv4 subnet/gateway from Docker.
- Native PostgreSQL binds the inspected gateway, retains existing databases/config, and restarts only after the gateway exists and only when `listen_addresses` changes.
- Native `DATABASE_URL` uses the inspected TAZAXY gateway; `host.docker.internal` is not preferred.
- Active UFW receives only `<subnet> -> <gateway>:<postgres-port>/tcp`; an existing exact rule is a no-op and public CIDRs remain rejected.
- Installer proves TCP plus PostgreSQL authentication with throwaway containers on `tazaxy-network` before `docker compose up`; failure aborts startup.
- Probe image is version-neutral (`postgres:alpine`); PostgreSQL config paths come from `SHOW config_file` / `SHOW hba_file`.

Changed files:
- `cli/commands/install.3xui.ts`
- `cli/installer/db-connectivity-verifier.js`
- `cli/installer/db-route-resolver.js`
- `cli/installer/postgres-provisioner.js`
- `cli/installer/db-route.test.cjs`
- `cli/installer/postgres-provisioner.test.cjs`
- `cli/installer/production-install-path.test.cjs`

Tests:
- Focused DB/order tests: 31/31 passed.
- `npm run test:installer`: 57/57 passed.
- `npm run cli:build`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.

Blockers: none.

Exact next action: stop after Session 1 and wait for explicit Session 2 instructions.

## Session 2 — Wallet Payment UUID Lock

Verified facts:
- `orders.publicId` is a PostgreSQL `UUID` column; the wallet and voucher `FOR UPDATE` queries were the two directly related raw order-public-ID locks binding a text parameter.
- Both locks now cast the parameter to `uuid` and leave the indexed database column unchanged.
- Malformed order public IDs return the normal `NOT_FOUND` business error before SQL; valid nonexistent IDs still return `Order not found` after the lock query.
- The canonical wallet debit → payment confirmation → order completion → provisioning transaction and its idempotency checks remain unchanged.
- The PostgreSQL regression executes `PaymentsService.payOrderWithWallet` inside a real PostgreSQL transaction against a real row in `orders.publicId UUID`.

Changed files:
- `src/modules/payments/payments.service.ts`
- `src/modules/payments/payments.service.spec.ts`
- `src/modules/payments/payments.uuid-lock.postgres.spec.ts`
- `REAL-SERVER-FIX-STATE.md`

Tests:
- Focused PaymentsService tests, including the real PostgreSQL UUID-lock regression: 14/14 passed.
- Available Telegram flow tests: 12/12 passed (`admin.flow.spec.ts`, `subscriptions.flow.spec.ts`); the repository has no `buy.flow.spec.ts`.
- `npm run build`: passed.
- `git diff --check`: passed.

Blockers: none.

Exact next action: stop after Session 2 and wait for explicit Session 3 instructions.

## Session 3 — MinIO / S3 Receipt Storage

Verified facts:
- Receipt uploads now use the official AWS SDK S3 client, which produces real AWS Signature V4 authentication for MinIO/S3 upload and delete operations.
- Private uploads return time-limited signed retrieval URLs; admin receipt views regenerate signed URLs from the stored object key instead of treating private objects as public.
- The configured bucket is checked before upload and created only when missing. Successful bootstrap is cached, concurrent/already-owned creation is idempotent, and no public-write bucket policy is applied.
- Local MinIO endpoints (`minio`, loopback, and private IPs) use a direct SDK transport and bypass the outbound proxy. External S3 endpoints can reuse the configured proxy agent.
- Presigned MinIO retrieval uses the externally reachable `S3_PUBLIC_URL` endpoint while authenticated storage operations continue to use `S3_ENDPOINT`.
- The production Compose/installer configuration already supplies matching endpoint, region, credentials, bucket, force-path-style, and external bucket URL values; no public bucket configuration was added.

Changed files:
- `package.json`
- `package-lock.json`
- `src/common/storage/s3-storage.service.ts`
- `src/common/storage/s3-storage.service.spec.ts`
- `src/common/storage/storage.module.ts`
- `src/modules/telegram/flows/buy.flow.spec.ts`
- `src/modules/telegram/flows/admin.flow.ts`
- `src/modules/telegram/flows/admin.flow.spec.ts`
- `REAL-SERVER-FIX-STATE.md`

Tests:
- Focused storage, BuyFlow receipt, admin receipt, and PaymentsService tests: 29/29 passed.
- Live MinIO integration: authenticated upload, bucket bootstrap/idempotency, signed private retrieval, and delete passed.
- `npm run build`: passed.
- `git diff --check`: passed.

Blockers: none.

Exact next action: stop after Session 3 and wait for explicit Session 4 instructions.

## Session 4 — Real-Server Acceptance / Final Verify

Status: INCOMPLETE — do not mark this state COMPLETE.

Executable verification completed on the available Windows Docker Desktop workspace:
- Rebuilt the production CLI before exercising its bundled installer path.
- Installer suites passed 78/78 total: `npm run test:installer` passed 57/57, and the directly relevant PostgreSQL provisioner/build-integrity suites passed 21/21.
- All payment-module suites passed 27/27, including an actually executed PostgreSQL-backed UUID order-lock regression (not skipped).
- All Telegram flow suites passed 13/13.
- Storage tests passed 6/6.
- Panel/XUI/VPN tests passed 45/45.
- A live temporary MinIO check passed authenticated private upload, signed retrieval (HTTP 200 with matching content), delete, and post-delete retrieval (HTTP 404); the temporary container was removed.
- `npm run cli:build` passed.
- `npm run build` passed.

Acceptance blockers / limitations:
- No fresh Linux server with native PostgreSQL, existing 3X-UI, no TAZAXY state, and the supported one-line entrypoint was available in this session. The complete production installer path therefore was not executed against the required topology.
- `InstallCommand.validateInstallation()` currently allows `docker compose ps` and its app-context check to fail, performs no `/health` or Compose health assertion, and still proceeds to the final success summary. The executable installer therefore does not yet prove healthy app/Redis/MinIO/nginx or prevent a false final-success message.
- The existing local Docker Desktop stack is stale and is not an acceptance substitute: `/health` returned 200 and its restart count stayed at 4 over 10 seconds, but Prisma reported migration `20260803160000_zarinpal_irt` unapplied, and no Telegram bot-start log match was found.

Exact next action:
- Add a focused, failing production-path regression for mandatory final health checks, make installer final validation fail closed, then execute the one-line installer on the specified fresh real-server topology and run the application smoke tests there. Only after that run passes may this state be marked COMPLETE.

## Session 1 regression follow-up — stale UFW bridge

Verified facts:
- Docker network inspection now resolves the active Linux bridge from the explicit bridge option or `br-<network-id-prefix>`.
- Native PostgreSQL UFW access is bound to the active bridge: `allow in on <bridge> from <subnet> to <gateway> port <port> proto tcp`.
- Interface identity is part of idempotency. Network recreation adds the new-bridge rule; stale rules are deleted only when the `tazaxy-postgres` ownership comment proves they belong to the installer.
- Unmarked stale and unrelated UFW rules are preserved.
- Fail-fast container TCP/auth probing remains in place, and installer failures now include the scrubbed `pg_isready` diagnostic.

Changed files:
- `cli/commands/install.3xui.ts`
- `cli/installer/db-connectivity-verifier.js`
- `cli/installer/db-route-resolver.js`
- `cli/installer/postgres-provisioner.js`
- `cli/installer/db-route.test.cjs`
- `cli/installer/postgres-provisioner.test.cjs`
- `cli/installer/production-install-path.test.cjs`

Tests:
- Focused DB/UFW/order tests: 35/35 passed.
- `npm run test:installer`: 59/59 passed.
- `npm run cli:build`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.

Blockers: Linux acceptance rerun is still required to prove the repaired UFW rule on the reported host.

Exact next action: deploy the rebuilt CLI to the acceptance host, rerun the installer, and verify the current bridge rule plus container-context `pg_isready`/`psql` success.

## Session 1 hotfix — Compose network ownership

Verified facts:
- Installer remains the canonical creator/inspector of `tazaxy-network`, including subnet, gateway, and bridge lifecycle.
- Compose now declares `tazaxy-network` as `external: true` with no duplicate driver/IPAM configuration.
- A Docker-backed regression pre-created the network, ran `docker compose up`, ran `docker compose down`, and proved the external network remained present.
- Fresh install creates the network before provisioning; reruns inspect and reuse it without requiring Compose ownership labels.

Changed files:
- `docker-compose.yml`
- `cli/installer/production-install-path.test.cjs`
- `REAL-SERVER-FIX-STATE.md`

Tests:
- Focused production ownership tests: 3/3 passed, including live Docker Compose.
- Focused DB/UFW tests: 33/33 passed.
- `npm run test:installer`: 60/60 passed.
- `npm run cli:build`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.

Blockers: Linux acceptance rerun remains required.

Exact next action: deploy the rebuilt CLI/Compose file to the acceptance host and rerun installation through successful container-context DB authentication and `docker compose up`.

## Session 4 regression follow-up — CLI discovery/status consistency

Verified facts:
- Discovery Menu now reads the canonical post-install `.env` database route and `.tazaxy/config.json` panel/runtime state, with legacy `installer-state.json` used only as fallback.
- A native PostgreSQL route is reported as discovered even when no PostgreSQL container exists; readiness is proved through the application container's `/health/ready` database check.
- Persisted installer-authenticated panel and subscription endpoints win over independently reconstructed host-local URLs.
- Panel diagnosis prints host-local listener probes separately from app-context endpoints and never sends a loopback XUI URL into the application container.
- Status drift reconciliation and panel diagnosis use the same canonical persisted XUI endpoint.
- A failed diagnostic command checks the app service independently and no longer reports the app container unavailable when it is running.
- Infrastructure detection distinguishes a partially verified configured/native PostgreSQL candidate from PostgreSQL being absent.

Changed files:
- `cli/index.ts`
- `cli/commands/infrastructure.ts`
- `cli/commands/panel.ts`
- `cli/commands/status.ts`
- `cli/installer/canonical-runtime.js`
- `cli/installer/canonical-runtime.test.cjs`
- `cli/installer/production-install-path.test.cjs`
- `package.json`
- `REAL-SERVER-FIX-STATE.md`

Tests:
- `npm run test:installer`: 68/68 passed.
- CLI build-integrity tests: 8/8 passed.
- `npm run cli:build`: passed.
- `npm run build`: passed.

Blockers: the updated CLI still requires deployment and rerun on the reported acceptance host; overall real-server acceptance remains INCOMPLETE until that executable rerun passes.

Exact next action: deploy the rebuilt CLI, then compare Discovery Summary, Health Status, Infrastructure, and Panel Diagnosis on the same healthy runtime and confirm they all report the canonical native-DB/XUI state.

## Session 1 regression follow-up — stale Compose container ownership

Verified facts:
- The TAZAXY application stack now has one deterministic Compose project identity, `tazaxy`, declared in `docker-compose.yml` and passed explicitly by installer, menu lifecycle, status, panel diagnosis, uninstall, Prisma, and reconciliation commands.
- Before each installer/menu `compose up`, the lifecycle reconciler lists Compose containers, inspects Docker ownership labels, and compares them with the canonical `tazaxy` project.
- A container is removable only when its service is a TAZAXY service and either its Compose project is `tazaxy` or its Compose config-file label exactly identifies the active TAZAXY compose file. Names alone never establish ownership.
- Owned containers left outside the canonical project by older/partial runs are removed with `docker rm -f` and recreated by Compose. No `-v` flag or network mutation is used, so `tazaxy-redis-data`, `tazaxy-minio-data`, `tazaxy-nginx-certs`, and the external installer-owned `tazaxy-network` survive.
- Current canonical project containers and unrelated/similarly named containers are preserved.
- Start and status discovery use the same `tazaxy` project identity as installation.

Changed files:
- `cli/installer/compose-lifecycle.js`
- `cli/installer/compose-lifecycle.test.cjs`
- `cli/installer/production-install-path.test.cjs`
- `cli/commands/install.interface.ts`
- `cli/commands/install.3xui.ts`
- `cli/commands/status.ts`
- `cli/commands/panel.ts`
- `cli/commands/maintenance.ts`
- `cli/index.ts`
- `docker-compose.yml`
- `scripts/install.sh`
- `package.json`
- `REAL-SERVER-FIX-STATE.md`

Tests:
- `npm run test:installer`: 73/73 passed, including stale ownership, partial-install rerun, data/network preservation, unrelated-container preservation, and live external-network survival.
- Focused Session 1 DB/UFW/production-order tests: 39/39 passed.
- CLI build-integrity tests: 8/8 passed.
- `docker compose -p tazaxy -f docker-compose.yml --env-file .env.example config --quiet`: passed.
- `npm run cli:build`: passed (29 installer modules copied).
- `npm run build`: passed.
- `git diff --check`: passed.

Blockers: Linux acceptance rerun is still required to prove self-healing against the reported stale container on the real server.

Exact next action: deploy the rebuilt CLI and rerun the supported installer; confirm the stale owned MinIO/Redis/app container is recreated while named volumes and `tazaxy-network` retain their data/identity.

## Session 4 acceptance follow-up — XUI diagnostic runtime packaging

Verified facts:
- `src/scripts/diagnose-xui.ts` remains the sole diagnostic executable and delegates to `PanelInstallerService.diagnoseXui`; no duplicate diagnosis implementation was added.
- Nest emits the executable at `dist/src/scripts/diagnose-xui.js`. The production Dockerfile copies the complete builder `/app/dist` tree to runtime `/app/dist`, so the executable is present at `/app/dist/src/scripts/diagnose-xui.js`.
- Panel Diagnosis now executes that packaged path inside the app container and parses the returned diagnostic JSON successfully.
- The sibling installer reconciliation and status drift commands were corrected to their same canonical Nest-emitted `dist/src/scripts` path contract.
- Canonical persisted panel/subscription endpoints and the existing `INSTALLER_VERIFIED` fallback state remain unchanged and covered by the focused CLI tests.

Changed files:
- `cli/commands/panel.ts`
- `cli/commands/install.3xui.ts`
- `cli/commands/status.ts`
- `cli/installer/build-integrity.test.cjs`
- `cli/installer/production-install-path.test.cjs`
- `XUI-INSTALLER-STATE.md`
- `REAL-SERVER-FIX-STATE.md`

Tests:
- Focused Panel Diagnosis CLI regressions: 2/2 passed.
- `PanelInstallerService` diagnostic/reconciliation tests: 9/9 passed.
- Production build-integrity tests: 9/9 passed; the suite rebuilt Nest output and verified the Docker COPY/path contract.
- `npm run cli:build`: passed (29 installer modules copied).
- `npm run build`: passed.
- `git diff --check`: passed.

Blockers: the corrected image/CLI still requires deployment to the acceptance host and one successful in-container Panel Diagnosis run there.

Exact next action: rebuild/deploy the production image and CLI, then run `tazaxy panel diagnose` and confirm it reaches `CONNECTED` without a module-path error.
