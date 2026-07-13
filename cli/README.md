# VPN SaaS CLI

Command-line interface for installing and managing the VPN SaaS bot on Linux servers.

## Installation

```bash
# Build the CLI
npm run cli:build

# Install globally (optional)
npm install -g

# Or run directly
npm run cli
```

## Commands

### `install` - Install 3x-UI and configure the bot

Installs 3x-UI panel and configures the VPN SaaS bot.

```bash
vpn-cli install [options]
```

**Options:**
- `--yes, -y` - Skip all confirmations
- `--skip3xui` - Skip 3x-UI installation (connect to existing)
- `--panel-url <url>` - Panel URL (e.g., http://1.2.3.4:2053)
- `--panel-user <user>` - Panel username
- `--panel-pass <pass>` - Panel password

**Examples:**
```bash
# Install everything from scratch
vpn-cli install

# Connect to existing 3x-UI
vpn-cli install --skip3xui --panel-url http://1.2.3.4:2053 --panel-user admin --panel-pass secret

# Non-interactive installation
vpn-cli install --yes --skip3xui --panel-url http://1.2.3.4:2053 --panel-user admin --panel-pass secret
```

### `admin` - Manage super admin settings

Manages Telegram user IDs that have access to the admin panel.

```bash
vpn-cli admin [options]
```

**Options:**
- `--list` - List all admins
- `--add <telegram_id>` - Add admin by Telegram ID
- `--remove <telegram_id>` - Remove admin by Telegram ID

**Examples:**
```bash
# List all admins
vpn-cli admin --list

# Add a new admin
vpn-cli admin --add 123456789

# Remove an admin
vpn-cli admin --remove 123456789
```

### `panel` - Manage 3x-UI panel connections

Manages connections to 3x-UI panels.

```bash
vpn-cli panel [options]
```

**Options:**
- `--list` - List all configured panels
- `--add` - Add a new panel
- `--remove` - Remove a panel
- `--test` - Test panel connection
- `--sync` - Sync users from panel
- `--url <url>` - Panel URL
- `--user <user>` - Panel username
- `--pass <pass>` - Panel password
- `--sub-port <port>` - Subscription port (default: 2053)
- `--sub-path <path>` - Subscription path (default: sub)

**Examples:**
```bash
# List all panels
vpn-cli panel --list

# Add a new panel
vpn-cli panel --add --url http://1.2.3.4:2053 --user admin --pass secret --sub-port 2053 --sub-path sub

# Test panel connection
vpn-cli panel --test --url http://1.2.3.4:2053 --user admin --pass secret

# Sync users from panel
vpn-cli panel --sync --url http://1.2.3.4:2053

# Remove a panel
vpn-cli panel --remove --url http://1.2.3.4:2053
```

### `status` - Show system status

Shows the health status of all system services.

```bash
vpn-cli status [options]
```

**Options:**
- `--verbose, -v` - Show detailed status information

**Examples:**
```bash
# Quick status check
vpn-cli status

# Detailed status
vpn-cli status --verbose
```

## Subscription Link Format

The subscription link format for 3x-UI is:
```
http://<server_ip>:<sub_port>/<sub_path>/<subscription_id>
```

Example:
```
http://1.2.3.4:2053/sub/a2c8a2e2-921b-496d-a143-9b16c8d6c53f
```

**Note:** The subscription port (`sub_port`) and path (`sub_path`) are configurable and may differ from the panel port.

## 3x-UI Installation Scenarios

### Scenario 1: Fresh Server (No 3x-UI installed)

The CLI will:
1. Download and install 3x-UI from GitHub
2. Configure panel settings (port, subscription port, subscription path)
3. Set up admin credentials
4. Install PostgreSQL and Redis if needed
5. Configure the bot environment
6. Run database migrations

### Scenario 2: Existing 3x-UI Installation

The CLI will:
1. Detect existing 3x-UI installation
2. Get current configuration (ports, subscription settings)
3. Test connection to the panel
4. Sync existing users to the bot database
5. Configure the bot to use the existing panel

## Configuration Files

The CLI creates and manages the following configuration files:

- `.env` - Bot environment variables
- `.3xui-config.json` - 3x-UI panel configuration
- `.panels-config.json` - Multiple panel connections
- `.admin-config.json` - Super admin Telegram IDs

## Requirements

- Linux server (Ubuntu 20.04+ / Debian 11+)
- Root or sudo access
- Node.js 18+
- PostgreSQL 14+ (optional, can be installed by CLI)
- Redis 6+ (optional, can be installed by CLI)

## Quick Start

```bash
# 1. SSH into your server
ssh root@your-server-ip

# 2. Clone the repository
git clone https://github.com/bysinaa/vpn-saas.git
cd vpn-saas

# 3. Build the CLI
npm run cli:build

# 4. Run installation
npm run cli:start install

# 5. Follow the prompts or use non-interactive mode
npm run cli:start install -- --yes --panel-url http://YOUR_IP:2053 --panel-user admin --panel-pass YOUR_PASSWORD
```

## Troubleshooting

### 3x-UI not detected

If the CLI cannot detect 3x-UI, check:
```bash
which x-ui
systemctl status x-ui
```

### Database connection failed

Ensure PostgreSQL is running:
```bash
systemctl status postgresql
pg_isready
```

### Redis connection failed

Ensure Redis is running:
```bash
systemctl status redis-server
redis-cli ping
```

## License

MIT