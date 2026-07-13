# VPN SaaS CLI

Production-oriented command-line interface for installing, validating, and managing the VPN SaaS platform on Linux servers with 3X-UI integration.

## Current Capabilities

The CLI currently provides:

- production installer flow
- runtime panel discovery and persistence
- dynamic subscription endpoint handling
- super admin management
- platform health inspection
- interactive menu/help entrypoint

Runtime state is stored in:

- `.vpn-saas/config.json`
- `.vpn-saas/installer.log`

Environment values are written to:

- `.env`

---

## Build and Run

```bash
# Build the CLI
npm run cli:build

# Run via npm script
npm run cli:start -- help

# Example installer run
npm run cli:start -- install

# Optional global execution after packaging
vpn-cli help
```

---

## Main Commands

### `install`

Installs or repairs the platform on a Linux server.

```bash
vpn-cli install [options]
```

Supported flow:

1. detect Linux distribution and CPU architecture
2. verify root privileges
3. verify/install Docker
4. verify/install Docker Compose plugin
5. install base packages
6. configure firewall
7. detect or bootstrap 3X-UI
8. generate `.env`
9. build and start Docker services
10. run Prisma generate/migrate
11. configure first Super Admin
12. validate runtime state
13. print final summary

Options:

- `--yes`, `-y` — auto-approve prompts when safe
- `--skip-3xui` — skip fresh 3X-UI installation attempt
- `--panel-url <url>` — existing panel URL
- `--panel-user <username>` — panel username
- `--panel-pass <password>` — panel password
- `--domain <domain>` — public domain name
- `--email <email>` — administrative email
- `--verbose`, `-v` — verbose logs

Examples:

```bash
vpn-cli install

vpn-cli install --yes --domain vpn.example.com

vpn-cli install --skip-3xui \
  --panel-url http://203.0.113.10:2053 \
  --panel-user admin \
  --panel-pass strong-password
```

---

### `admin`

Manages Super Admin Telegram IDs used by the platform.

```bash
vpn-cli admin [options]
```

Options:

- `--list`
- `--add <telegram_id>`
- `--remove <telegram_id>`
- `--change <telegram_id>`

Examples:

```bash
vpn-cli admin --list
vpn-cli admin --add 123456789
vpn-cli admin --remove 123456789
vpn-cli admin --change 987654321
```

Behavior:

- persists Super Admins into runtime config
- updates `.env` via `TELEGRAM_ADMIN_IDS`
- keeps the first item as the primary Super Admin

---

### `panel`

Discovers and manages 3X-UI runtime settings.

```bash
vpn-cli panel [options]
```

Options:

- `--list`
- `--add`
- `--discover`
- `--test`
- `--sync`
- `--remove`
- `--url <url>`
- `--user <username>`
- `--pass <password>`
- `--sub-port <port>`
- `--sub-path <path>`

Examples:

```bash
vpn-cli panel --discover --url http://127.0.0.1:2053 --user admin --pass secret

vpn-cli panel --add \
  --url https://panel.example.com:2053 \
  --user admin \
  --pass secret \
  --sub-port 2096 \
  --sub-path subscription

vpn-cli panel --test
vpn-cli panel --list
```

Behavior:

- saves dynamic panel runtime data
- stores panel API URL
- stores dynamic subscription base URL
- stores dynamic subscription port/path
- avoids fixed localhost subscription assumptions in the CLI layer

---

### `status`

Shows platform health information.

```bash
vpn-cli status [options]
```

Options:

- `--verbose`, `-v`

Checks:

- Docker
- Docker Compose
- 3X-UI
- PostgreSQL
- Redis
- application process/container presence
- expected port occupancy

Example:

```bash
vpn-cli status --verbose
```

---

### `menu`

Displays the interactive management menu.

```bash
vpn-cli menu
```

Current menu includes:

1. Install Platform
2. Update Platform
3. Start Services
4. Stop Services
5. Restart Services
6. View Logs
7. Health Status
8. Configure Super Admin
9. Configure Telegram
10. Configure 3X-UI
11. Backup
12. Restore
13. Exit

---

## Dynamic Subscription URL Handling

The CLI no longer assumes fixed subscription URLs such as:

```text
http://127.0.0.1:2053/sub/<subId>
```

Instead, runtime configuration is used to construct:

```text
http(s)://<server>:<configured_port>/<configured_sub_path>/<subscription_id>
```

Examples:

```text
https://vpn.example.com:2096/subscription/abc123
http://203.0.113.10:2053/sub/abc123
http://203.0.113.10:2087/custompath/abc123
```

The runtime panel configuration stores:

- `VPN_PANEL_URL`
- `VPN_PANEL_API_URL`
- `VPN_PANEL_SUBSCRIPTION_BASE_URL`
- `VPN_PANEL_SUBSCRIPTION_PATH`
- `VPN_PANEL_SUBSCRIPTION_PORT`

---

## Official 3X-UI Subscription Endpoint Convention

The CLI is aligned with the official 3X-UI subscription pattern:

```text
GET /{subPath}{subid}
```

Operationally, the project models this as:

```text
/<sub_path>/<subscription_id>
```

Expected behavior from 3X-UI:

- returns Base64-encoded subscription links by default
- renders HTML subscription info when:
  - header `Accept: text/html` is sent, or
  - query string `?html=1` is appended

The CLI runtime model supports building both regular and HTML-friendly endpoint URLs.

---

## Installation Scenarios

### Scenario 1: Existing 3X-UI Installation

Installer path:

- detect existing 3X-UI presence
- connect using provided/discovered credentials
- save runtime panel metadata
- preserve existing panel data
- prepare the platform for future import/sync workflows

### Scenario 2: Fresh 3X-UI Installation

Installer path:

- download official 3X-UI install script
- execute installer
- store runtime panel metadata
- configure panel runtime values for the platform
- continue platform deployment flow

---

## Runtime Files

The CLI now centers on these files:

- `.vpn-saas/config.json` — runtime platform state
- `.vpn-saas/installer.log` — installer log output
- `.env` — active application environment

Example stored runtime structure includes:

- platform info
- public IP / domain / ports
- Super Admin list
- panel API URL
- subscription base URL
- subscription path
- subscription port
- backup directory metadata

---

## Supported Platforms

Currently targeted:

- Ubuntu 20.04+
- Ubuntu 22.04+
- Debian 11+
- Debian 12+
- compatible RHEL-family distributions where package tooling is available

Recommended architecture:

- `x86_64` / `amd64`
- `aarch64` / `arm64`

---

## Quick Start

```bash
ssh root@your-server-ip
git clone https://github.com/bysinaa/vpn-saas.git
cd vpn-saas
npm install
npm run cli:build
npm run cli:start -- install
```

Existing 3X-UI example:

```bash
npm run cli:start -- install \
  --skip-3xui \
  --panel-url http://YOUR_SERVER_IP:2053 \
  --panel-user admin \
  --panel-pass YOUR_PASSWORD
```

---

## Troubleshooting

### Docker check

```bash
docker --version
docker compose version
systemctl status docker
```

### 3X-UI check

```bash
which x-ui
systemctl status x-ui
x-ui status
```

### PostgreSQL check

```bash
pg_isready
systemctl status postgresql
```

### Redis check

```bash
redis-cli ping
systemctl status redis-server
```

### CLI health check

```bash
npm run cli:start -- status --verbose
```

---

## Known Remaining Work

The following areas are still pending for full production parity with the broader feature request:

- backup/restore execution commands
- start/stop/restart/logs/update commands
- deeper 3X-UI import and incremental synchronization
- token refresh / retry / timeout / richer API client behavior
- backend NestJS subscription generator refactor
- extended deployment documentation

---

## License

MIT