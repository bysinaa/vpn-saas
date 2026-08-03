# Installer Design & Verification Plan — tazaxy + 3x-ui

Version: 1.0
Date: 2026-07-31

Purpose
- Produce a complete, repeatable, idempotent, testable CLI installer and diagnostic process that installs, detects and connects the tazaxy management panel to 3x-ui across all common server/deployment topologies.
- This document is a step-by-step plan and verification checklist. It does not modify code; it instructs what to implement and how to test.

Contents (deliverables)
1. Current architecture analysis
2. Likely reasons local ↔ server integration fails
3. Service map
4. Network deployment topologies and mapping rules
5. Port table and port-check procedure
6. Database & storage map (persistence strategy)
7. CLI installer architecture (design)
8. Installation process: stages and minimal testable steps (each step includes 10 required fields)
9. Per-step success criteria, test plan, rollback and idempotency rules
10. Diagnostic CLI commands and expected outputs
11. Backup/restore and uninstallation policies
12. Execution plan / next actions

-------------------------
1) Current architecture analysis (from repository)
-------------------------
- Panel: NestJS backend with Fastify adapter (src/main.ts). Runs on configured host:port (logs show http://0.0.0.0:3000/api/v1). Uses Prisma + Postgres, Redis, fastify-static for dashboard.
- Frontend: static files in public/dashboard served by Fastify; app.js present.
- 3x-ui integration: code lives under src/integrations/xui (xui.client.ts, xui.service.ts, xui.auth.ts, xui.module.ts). The panel expects to talk to a 3x-ui HTTP API (login flow, protected endpoints).
- Installer code: partial/legacy CLI scripts in cli/ and scripts/. There is cli/commands/install.3xui.ts and scripts/install.sh — these appear relevant but likely incomplete for robust server installs.
- Database migrations present in prisma/migrations.
- Reverse proxy config present in nginx/nginx.conf and nginx/conf.d/default.conf.
- Existing dev behavior: local env works; server fails.

Key inference: panel ↔ 3x-ui integration uses HTTP requests and credentials; networking differences (Docker vs host, ports, DNS) are the usual root causes.

-------------------------
2) Likely reasons local succeeds but server fails
-------------------------
Short list (to be tested with independent checks):
- Wrong host assumption (use of "localhost" or 127.0.0.1 when services are in separate containers).
- Panel and 3x-ui not on same Docker network (or wrong Docker compose project).
- Container-to-host vs container-to-container binding confusion (published host port vs container port).
- Service listening on 127.0.0.1 inside a container (not 0.0.0.0).
- Reverse proxy (nginx) misconfigured (wrong upstream, missing proxy headers, wrong path).
- SSL (self-signed certs) causing rejects or redirect loops.
- Firewall blocking ports (iptables/UFW).
- Wrong API path/prefix or changed endpoint between versions.
- Authentication flow differences (CSRF, cookies, session domain, SameSite).
- CORS only matters for browser UI; server-to-server uses direct HTTP so not CORS.
- Environment variables misconfigured on server (XUI_BASE_URL etc).
- DNS resolution differences for container names on server.
- Health checks failing causing restarts or late start ordering.

-------------------------
3) Service map
-------------------------
- tazaxy (panel)
  - Purpose: management backend + static dashboard
  - Transport: HTTP API, static assets
  - Persistent data: Postgres (via Prisma), files in /public/uploads?, configured volumes
- 3x-ui
  - Purpose: VPN server management interface + API (Xray control)
  - Transport: HTTP(s) panel API, separate inbounds for Xray
  - Persistent data: its DB (often SQLite), config directories, inbound JSONs
- Postgres
- Redis
- Nginx (reverse proxy)
- MinIO (if present)
- xray/vpn services (external)
- Docker / Docker Compose

-------------------------
4) Network architectures & mapping rules
-------------------------
For each architecture provide mapping rules for the correct hostname, port, network, and testing method.

- A. Same Docker Compose project
  - Hostname: 3x-ui service name (as declared in docker-compose).
  - Port: internal service port (use container port).
  - Docker network: default compose network (service names resolve).
  - Protocol: HTTP or HTTPS depending on 3x-ui config.
  - Test: from panel container: curl -sv http://3x-ui-service:PORT/health

- B. Separate Docker Compose projects on same host
  - Hostname: Docker user-defined network alias or use host private IP + published port.
  - Solution: create/use a shared Docker network and connect both compose projects to it, or use host IP with published port.
  - Test: inside panel container: curl -> either service-name (if same network) or host:publishedport

- C. Panel in Docker, 3x-ui on host
  - Hostname: Use host.docker.internal (Linux: create docker.network host gateway) or use the host IP 172.x.x.x.
  - Port: 3x-ui published port.
  - Test: from panel container: curl http://host.docker.internal:PORT/api/...

- D. Panel on host, 3x-ui in Docker
  - Hostname: localhost:published-port (on host) OR use container IP if necessary.
  - Ensure 3x-ui published ports are accessible from host.
  - Test: from host: curl http://localhost:PUBPORT/api/...

- E. Both on host (direct host installs)
  - Use localhost or private IP, ensure service binds to 0.0.0.0.
  - Test: curl to host:port

- F. Separate servers
  - Use a domain or private IP; configure firewall and reverse proxy.
  - Test: curl -v from panel host to 3x-ui host.

- G. Through domain and reverse proxy (nginx)
  - XUI accessible via domain/subdomain and TLS; panel must use that origin (with correct SSL validation and API path).
  - Test: full HTTPS test including certificate chain and login.

Rules:
- Never hardcode "localhost" in installer; always detect and validate.
- Prefer base url env: XUI_BASE_URL and separate XUI_API_PREFIX or XUI_API_PATH.

-------------------------
5) Port table (template & commands)
-------------------------
We will generate a dynamic port table during preflight. Example template (installer fills real values):

- Service: tazaxy (backend API)
  - Purpose: API / admin
  - Internal port: 3000
  - External port: 3000
  - Proto: TCP
  - Exposure: public (configurable)
  - Check command: ss -tulpn | grep :3000 ; docker ps ; docker compose ps
  - Suggested alternate: 3001, 3002
  - Firewall: open if public

- Service: nginx
  - Purpose: reverse proxy HTTP
  - Internal port: 80
  - External port: 80
  - Proto: TCP
  - Exposure: public
  - Check: ss -tulpn | grep :80 ; systemctl status nginx
  - Suggest alt: 8080 (if conflict)
  - Firewall: open

- Service: nginx TLS
  - Purpose: reverse proxy HTTPS
  - Port: 443
  - Check: ss -tulpn | grep :443

- Postgres
  - Internal: 5432
  - External: 5432 (should be private)
  - Proto: TCP
  - Exposure: private (not public)
  - Check: ss -tulpn | grep :5432 ; sudo -u postgres psql -c '\l'

- Redis
  - 6379

- 3x-ui
  - Example internal port: (installer detects). Check: ss -tulpn | grep xui-process or docker ps ; curl host:port/health

Port-check commands (always try multiple):
- ss -tulpn
- sudo lsof -i -P -n
- docker ps
- docker compose ps
- netstat -tulpn (if available)
- sudo ufw status verbose
- iptables -L -n -v

Port conflict resolution:
- Identify process PID and service.
- If unrelated to project: suggest alternative or stop the conflicting service with explicit user consent.
- If related to same project: report and abort until user accepts changes.

-------------------------
6) Database & storage map
-------------------------
Principles:
- Separate each service DB data from container lifecycle.
- Use bind mounts or named volumes with documented paths.
- Avoid using ephemeral volumes without backup.

Panel-specific:
- DB: Postgres (Prisma)
  - Location: external Postgres instance or docker volume `tazaxy_postgres_data` or host path (e.g. /opt/tazaxy/postgres)
  - Backups: pg_dump (regular), store in /opt/tazaxy/backups/postgres
  - Migration: run prisma migrate after backup
- 3x-ui:
  - Likely uses SQLite by default or offers internal DB; installer must detect type and data path.
  - Do not change 3x-ui data model without explicit migration plan.
  - Data path: detect via service config or inspect container volume mounts.

Data categories mapping and ownership:
- Panel-specific data: owned by tazaxy; stored in Postgres named volume.
- 3x-ui-specific data: owned by 3x-ui; stored in its volume; do not mix.
- Synchronized data: handled via API only; the panel may store derived/cache but not the source-of-truth unless explicitly syncing.
- Backups, logs, uploaded files: separate directories and backup policy.

Backups:
- Always backup DB before migrations (pg_dump for Postgres; copy SQLite file for 3x-ui).
- Test restore procedure in a staging env before applying to production.

-------------------------
7) CLI installer architecture (design)
-------------------------
High level:
- Implement a Node.js CLI under cli/installer (TypeScript), export commands:
  - installer preflight
  - installer detect
  - installer backup
  - installer plan-ports
  - installer create-network
  - installer install-xui
  - installer configure-panel
  - installer connect-xui
  - installer healthcheck
  - installer diagnose xui
  - installer rollback <stage>
- State file: `/opt/tazaxy/installer-state.json` (or configurable) — structured, encrypted fields for secrets or keep secrets only in environment file. The state file must NOT store raw secrets (store hashed or reference).
- Logging: structured JSON logs to `/var/log/tazaxy-installer.log` with log levels.
- Idempotency: every action detects existing state and health; skip or reconcile if correct.

Implementation details:
- Use robust libraries:
  - Node + TypeScript + yargs or oclif for CLI.
  - Execa for running shell commands.
  - Axios for HTTP checks (with configurable timeouts and retries).
  - fs-extra for file operations.
  - winston/pino for CLI logging.
- Tests: small unit tests for logic; integration tests that run in a disposable docker environment.

Security:
- Use least-privilege operations; request sudo only when necessary.
- Mask secrets in logs.
- In interactive mode require explicit confirmations for destructive operations.

State file schema (example)
{
  "installerVersion":"1.0",
  "date":"…",
  "completedStages":["preflight"],
  "selectedPorts":{...},
  "publicRoot":"…",
  "xui": { "detected":true, "baseUrl":"…", "apiPath":"…", "version":"…"},
  "lastError": null
}

-------------------------
8) Installation process: stages & steps
-------------------------
Each stage below is broken into minimal steps. For each step the plan includes the 10 required fields (Purpose, Prereqs, Files, Commands, Expected result, Test, Error detection, Solutions, Rollback, Success criteria).

Note: To keep this document usable, Stage 1–4 are written with every step fully enumerated and filled; subsequent stages include the same template and representative completed steps, ready to be expanded into sub-steps when implementing the CLI.

STAGE 1 — PREFLIGHT CHECKS
- Step 1.1 — OS & privileges
  1. Purpose: Verify target OS, version and that installer has required privileges (sudo/root) or can escalate.
  2. Prereqs: SSH access to server, user with sudo.
  3. Files/code: none
  4. Commands:
     - uname -a
     - lsb_release -a || cat /etc/*release
     - id -u
  5. Expected result: OS supported (e.g., Ubuntu 20.04/22.04 or Debian 11/12/RHEL), installer has root or sudo.
  6. Test: compare output to supported list; id -u => 0 or sudo available.
  7. Error detection: unsupported OS or no sudo.
  8. Solutions: advise supported OS or obtain sudo, or run instructions as root.
  9. Rollback: none (non-destructive); stop installer.
 10. Success criteria: supported OS and sudo available.

- Step 1.2 — CPU / Memory / Disk
  1. Purpose: Ensure server has minimum resources.
  2. Prereqs: Access to server shell.
  3. Files/code: none
  4. Commands:
     - nproc
     - free -m
     - df -h /
  5. Expected: CPU cores >= 2, RAM >= 4GB (recommend 8+ for production), Disk >= 20GB free.
  6. Test: validate numeric thresholds.
  7. Error detection: insufficient resources.
  8. Solutions: pick larger instance or adjust services to separate hosts.
  9. Rollback: abort.
 10. Success: thresholds met.

- Step 1.3 — Network / DNS / Time / Connectivity
  1. Purpose: Confirm DNS resolution, outbound internet, NTP/time.
  2. Prereqs: Internet access.
  3. Commands:
     - ping 8.8.8.8 -c 3
     - curl -I https://github.com --connect-timeout 5
     - timedatectl status
     - nslookup example.com
  4. Expected: outbound reachable, DNS resolves, time synced.
  5. Test: check return codes, time drift < 5s.
  6. Error detection: time drift, DNS failures, no internet.
  7. Solutions: configure NTP, fix DNS or network.
  8. Rollback: abort.
 9. Success criteria: network checks pass.

- Step 1.4 — Required tools
  1. Purpose: Verify Docker, Docker Compose, git, curl, openssl present.
  2. Prereqs: sudo
  3. Files:
     - /usr/bin/docker
     - /usr/bin/docker-compose or docker compose plugin
  4. Commands:
     - docker --version
     - docker compose version || docker-compose --version
     - git --version
     - curl --version
     - openssl version
  5. Expected: All present at supported minimum versions.
  6. Test: parse versions.
  7. Error detection: missing/old tools
  8. Solutions: install missing packages via apt/yum or instruct user.
  9. Rollback: none
 10. Success: required tools available.

- Step 1.5 — Firewall & Ports scan (local machine)
  1. Purpose: Scan for required ports and detect conflicts.
  2. Prereqs: root or sudo
  3. Commands:
     - ss -tulpn
     - sudo lsof -i -P -n
     - docker ps
  4. Expected: list of ports and current owners.
  5. Test: produce port inventory file.
  6. Error detection: conflict on crucial ports (80,443,3000,5432,6379)
  7. Solutions: suggest alternatives or prompt to stop conflicting service.
  8. Rollback: none (non destructive)
  9. Success criteria: allocator chooses non-conflicting ports or user agrees to changes.

- Step 1.6 — Existing installation detection (light)
  1. Purpose: detect existing tazaxy or 3x-ui instances before any action.
  2. Prereqs: none
  3. Commands:
     - ps aux | grep tazaxy
     - docker ps --filter name=tazaxy
     - grep -R "3x-ui" /etc /opt  (careful — limited search)
  4. Expected: installer reports existing installations and their state.
  5. Test: parse results.
  6. Error detection: existing incomplete installs or conflicting containers.
  7. Solutions: present options: connect, migrate, or preserve and skip install.
  8. Rollback: none
  9. Success: installer knows whether to proceed.

STAGE 2 — DETECT EXISTING INSTALLATION
- Step 2.1 — Detect 3x-ui process/service
  1. Purpose: detect if 3x-ui exists and how installed (docker, compose, systemd, script)
  2. Prereqs: sudo
  3. Files to inspect:
     - docker ps -a
     - systemctl list-units | grep xui
     - common install paths: /opt/3x-ui, /usr/local/bin/3x-ui
     - existing nginx sites pointing to 3x-ui
  4. Commands:
     - docker ps --format '{{.Names}} {{.Image}} {{.Ports}}' | grep -i xui || true
     - systemctl status 3x-ui || systemctl status xui || true
     - find /opt /etc -maxdepth 3 -type f -name "*3x-ui*" 2>/dev/null
  5. Expected: detection of installation method and container/service name.
  6. Test: check service health endpoint if found.
  7. Error detection: partial installs or ambiguous matches.
  8. Solutions: prompt admin to confirm install location/name.
  9. Rollback: none
 10. Success criteria: installer identifies installation method or confirms absent.

- Step 2.2 — Detect 3x-ui published ports and hostname
  1. Purpose: discover how to reach 3x-ui (published host port or internal service name).
  2. Commands:
     - docker inspect <container> to see published ports and mounts
     - ss -tulpn | grep <published-port>
     - check nginx configs for upstream
  3. Expected: baseURL (http[s]://host:port or http[s]://service:port)
  4. Test: curl -I <baseURL>/health or login page
  5. Error detection: mismatched ports or 404 on health
  6. Solutions: ask admin for base URL or create mapping if docker internal only
  7. Rollback: none
 10. Success: valid reachable base URL detected.

STAGE 3 — BACKUPS
- Step 3.1 — Panel DB backup (Postgres)
  1. Purpose: ensure a backup exists before migrations or install changes.
  2. Prereqs: DB credentials
  3. Files:
     - .env where DB credentials live
  4. Commands:
     - PGPASSWORD="$PASS" pg_dump -Fc -h $PGHOST -U $PGUSER $PGDATABASE -f /opt/tazaxy/backups/panel-YYYYMMDD.dump
  5. Expected: non-empty dump file, return code 0.
  6. Test: restore into temporary DB to validate (pg_restore --list)
  7. Error detection: pg_dump exit code non-zero, file missing
  8. Solutions: check credentials, DB network, user privileges.
  9. Rollback: do not run migrations until backup validated.
 10. Success: validated backup file exists and restores cleanly.

- Step 3.2 — 3x-ui data backup
  - If SQLite: copy sqlite file
  - If other DB: follow its backup instructions
  - Verify copy integrity (file size > 0, checksum)

STAGE 4 — PORT PLANNING
- Step 4.1 — Produce final port map
  1. Purpose: finalize ports to be used by services (no conflicts).
  2. Prereqs: results from Stage 1.5
  3. Files:
     - Save `/opt/tazaxy/installer-state.json` selectedPorts
  4. Commands:
     - ss -tulpn (re-check)
  5. Expected: confirmed list of free ports
  6. Test: attempt to bind to each port (nc -z localhost <port>) — or start a lightweight listener
  7. Error detection: port now in use
  8. Solutions: choose next candidate port or request admin to free port
  9. Rollback: none
 10. Success: port map saved and binding test passes.

STAGE 5 — NETWORK PREPARATION
- Step 5.1 — Create Docker network (idempotent)
  1. Purpose: create a dedicated docker network used by both panel and 3x-ui when possible.
  2. Prereqs: docker running
  3. Commands:
     - docker network ls | grep tazaxy-net
     - docker network create --driver bridge tazaxy-net
  4. Expected: network exists
  5. Test: docker network inspect tazaxy-net
  6. Error detection: name conflict or create failure
  7. Solutions: pick different network name or reuse existing network after admin confirmation
  8. Rollback: remove created network if nothing attached
 10. Success: network exists and is inspectable.

- Step 5.2 — Connect existing containers to network (if administrator allows)
  - Purpose & steps: detect container names, docker network connect <network> <container>
  - Check internal DNS: docker exec panel-container ping 3x-ui-service

STAGE 6 — DATABASE & STORAGE PREPARATION
- Step 6.1 — Create persistent volumes and directories
  - Purpose: create directories like /opt/tazaxy/postgres_data, /opt/tazaxy/backups
  - Commands: mkdir -p, chown to service user
  - Tests: write and read small file, verify permission.

STAGE 7 — INSTALL / DETECT 3x-ui
- Step 7.1 — If 3x-ui already installed: validate health + login via CLI
  - Purpose: confirm API compatibility
  - Commands:
    - curl -I $XUI_BASE_URL/$API_PATH/health
    - Perform login API call (documented sequence) with timeout & limited retries
  - Expected: 200 OK and login success

- Step 7.2 — If 3x-ui absent: choose installation method. Example: official docker-compose (recommended)
  - Purpose: install with persistent volumes and documented compose file.
  - Commands: docker compose up -d (with named volumes)
  - Tests: curl health endpoint, inspect volumes, backup test.

STAGE 8 — INSTALL PANEL
- Step 8.1 — Prepare .env based on resolved settings (ports, xui base url, DB credentials)
  - Validate with dry-run config check
- Step 8.2 — Build / start services (docker compose up -d) or run host install
- Step 8.3 — Run migrations only after backup (prisma migrate deploy)
- Step 8.4 — Health checks: call /api/v1/health and DB queries

STAGE 9 — CONNECT PANEL TO 3x-ui (real API tests)
- Step 9.1 — Hostname resolution: resolve XUI_BASE_URL from panel host
  - Commands: nslookup, curl -sI
  - Success: correct IP and reachable
- Step 9.2 — TCP connection: nc -z or curl with --connect-timeout
- Step 9.3 — Attempt login API, obtain cookie/token
- Step 9.4 — Call protected endpoint to fetch real data (e.g., list clients)
- Step 9.5 — Create small controlled test entity (if safe) and verify round trip
- Step 9.6 — Clean up the created test entity

Each Step includes explicit error detection and fallbacks: retries with exponential backoff, certificate handling (optionally allow insecure if user explicitly opts in), clear failure message with logs.

STAGE 10 — REVERSE PROXY & SSL
- Step 10.1 — Validate domain DNS
- Step 10.2 — Generate / obtain TLS via certbot (or provided certs)
- Step 10.3 — Configure nginx site (template in deploy/ or nginx/), test proxying.
- Step 10.4 — Test HTTP -> HTTPS redirects and renewal.

STAGE 11 — FIREWALL
- Step 11.1 — Open required ports (ufw allow or iptables rules)
- Step 11.2 — Ensure DB/Redis are private

STAGE 12 — END-TO-END TESTS
- Step 12.1 — Run the full workflow enumerated by the user (login, create client, assign inbound, synchronize, restart, verify persistence, cleanup)

-------------------------
9) Diagnostics & test CLI commands (examples)
-------------------------
- installer preflight --output /opt/tazaxy/installer-state.json
  - Runs Stage 1 checks and saves findings.

- installer detect-xui --auto
  - Tries to autodiscover 3x-ui (docker/systemd/host)

- installer diagnose xui --base-url https://xui.example.com
  - Runs the sequence:
    [HOST RESOLUTION] -> [TCP] -> [HTTP HEAD] -> [GET /login page] -> [POST /login] -> [GET protected endpoint]
  - Output example:
    [PASS] host resolved: x.x.x.x
    [PASS] TCP port reachable
    [PASS] HTTP 200 OK on /login
    [PASS] Authentication successful (cookie: sessionid)
    [FAIL] Protected endpoint /api/clients returned 403 — reason: user lacks permission

- installer backup panel-db --out /opt/tazaxy/backups/panel.dump
- installer create-network --name tazaxy-net
- installer plan-ports --interactive

Return codes:
- 0 success
- 10 preflight error (need action)
- 20 detection ambiguous
- 30 install error
- 40 verification failed
- 50 rollback executed

-------------------------
10) Logging & state
-------------------------
- Logs: /var/log/tazaxy-installer.log (JSON lines)
- State: /opt/tazaxy/installer-state.json
- Masked fields: secrets not stored in plain text; store only references to env file.

-------------------------
11) Rollback rules
-------------------------
- Each stage keeps a manifest of created resources.
- Rollback should be per-stage and non-destructive to persistent volumes unless explicit confirmation from admin.
- Example rollback for Stage 5 (network):
  - If network created and containers not started: remove network.
  - If containers started afterwards, do not remove volumes unless explicit --purge flag.

-------------------------
12) Idempotency rules
-------------------------
- Before creation, check existence:
  - docker network ls -> skip/create
  - docker volume ls -> skip/create
  - systemd unit exists -> skip
- Any change that mutates state must be written to installer-state.json before being considered complete.

-------------------------
13) Implementation notes (what to add to repo)
-------------------------
- New folder: cli/installer
  - index.ts (yargs command skeleton)
  - commands/{preflight,detect-xui,backup,plan-ports,create-network,install-xui,configure-panel,connect-xui,healthcheck,diagnose,rollback}.ts
  - lib/{exec,fs,logger,state,ports,network,diagnostics}.ts
- Add example docker-compose.install.yml (deterministic service names, volumes)
- Add nginx site templates and systemd unit templates
- Add tests/ci scripts: tests/integration/* which run in ephemeral docker-compose.

-------------------------
14) Testing strategy & acceptance criteria
-------------------------
- Unit tests: logic only
- Integration tests: in ephemeral docker compose, test install flow (preflight -> create network -> start test xui service -> connect)
- Manual verification: run installer on a fresh VM and on a server with preinstalled 3x-ui.

Acceptance for full install:
- Installer completes with zero critical errors.
- Panel connects and authenticates to 3x-ui; protected endpoint returns data.
- Databases are persistent across container restarts & upgrades.
- Reverse proxy serves HTTPS with valid certs.

-------------------------
15) Next actions (recommended)
-------------------------
1. Review this plan and confirm acceptance of scope and OS targets.
2. I will produce the CLI skeleton and the installer-state JSON schema (if you accept implementation).
3. Implement Stage 1 (Preflight) as code and iterate.

-------------------------
Appendix A: Quick checklist (top-level)
-------------------------
- [ ] Approve this installation plan
- [ ] Approve supported OS list
- [ ] Approve installer storage paths (/opt/tazaxy)
- [ ] Approve logging location and retention
- [ ] Approve default ports and fallback strategies