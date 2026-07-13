#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * VPN SaaS CLI - Server Installation and Management Tool
 */
const install_3xui_1 = require("./commands/install.3xui");
const admin_1 = require("./commands/admin");
const panel_1 = require("./commands/panel");
const status_1 = require("./commands/status");
// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0];
const options = parseOptions(args.slice(1));
async function main() {
    console.log('\n🔧 VPN SaaS CLI v1.0.0\n');
    switch (command) {
        case 'install':
        case 'i':
            await runInstall(options);
            break;
        case 'admin':
        case 'a':
            await runAdmin(options);
            break;
        case 'panel':
        case 'p':
            await runPanel(options);
            break;
        case 'status':
        case 's':
            await runStatus(options);
            break;
        case 'help':
        case 'h':
        case undefined:
            showHelp();
            break;
        default:
            console.log(`Unknown command: ${command}\n`);
            showHelp();
            process.exit(1);
    }
}
function parseOptions(args) {
    const opts = {};
    let i = 0;
    while (i < args.length) {
        const arg = args[i];
        if (arg.startsWith('--')) {
            const key = arg.slice(2);
            const nextArg = args[i + 1];
            // Boolean flags
            if (['list', 'add', 'remove', 'test', 'sync', 'skip3xui', 'yes', 'y', 'verbose', 'v'].includes(key)) {
                opts[key] = true;
                i++;
            }
            // Value flags
            else if (nextArg && !nextArg.startsWith('--')) {
                // Convert numeric values
                if (/^\d+$/.test(nextArg)) {
                    opts[key] = parseInt(nextArg, 10);
                }
                else {
                    opts[key] = nextArg;
                }
                i += 2;
            }
            else {
                opts[key] = true;
                i++;
            }
        }
        else if (arg.startsWith('-')) {
            // Short flags
            const short = arg.slice(1);
            switch (short) {
                case 'l':
                    opts.list = true;
                    break;
                case 'a':
                    opts.add = true;
                    break;
                case 'r':
                    opts.remove = true;
                    break;
                case 't':
                    opts.test = true;
                    break;
                case 's':
                    opts.sync = true;
                    break;
                case 'y':
                    opts.yes = true;
                    break;
                case 'v':
                    opts.verbose = true;
                    break;
                case 'h':
                    opts.help = true;
                    break;
                default: opts[short] = true;
            }
            i++;
        }
        else {
            // Positional arguments
            i++;
        }
    }
    return opts;
}
async function runInstall(options) {
    const installCmd = new install_3xui_1.InstallCommand();
    await installCmd.execute(options);
}
async function runAdmin(options) {
    const adminCmd = new admin_1.AdminCommand();
    await adminCmd.execute(options);
}
async function runPanel(options) {
    const panelCmd = new panel_1.PanelCommand();
    await panelCmd.execute(options);
}
async function runStatus(options) {
    const statusCmd = new status_1.StatusCommand();
    await statusCmd.execute(options);
}
function showHelp() {
    console.log(`
🔧 VPN SaaS CLI - Server Installation and Management Tool

USAGE:
  vpn-cli <command> [options]

COMMANDS:
  install, i     Install 3x-UI and configure the bot
  admin, a       Manage super admin settings
  panel, p       Manage 3x-UI panel connections
  status, s      Show system status
  help, h        Show this help message

INSTALL OPTIONS:
  --yes, -y      Skip all confirmations
  --skip3xui     Skip 3x-UI installation
  --panel-url    Panel URL
  --panel-user   Panel username
  --panel-pass   Panel password

ADMIN OPTIONS:
  --list         List all admins
  --add <id>     Add admin by Telegram ID
  --remove <id>  Remove admin by Telegram ID

PANEL OPTIONS:
  --list         List all panels
  --add          Add a new panel
  --remove       Remove a panel
  --test         Test panel connection
  --sync         Sync users from panel
  --url          Panel URL
  --user         Panel username
  --pass         Panel password
  --sub-port     Subscription port (default: 2053)
  --sub-path     Subscription path (default: sub)

STATUS OPTIONS:
  --verbose, -v  Show detailed status information

EXAMPLES:
  # Install everything from scratch
  vpn-cli install

  # Connect to existing 3x-UI
  vpn-cli install --skip3xui --panel-url http://1.2.3.4:2053 --panel-user admin --panel-pass secret

  # Add admin
  vpn-cli admin --add 123456789

  # List admins
  vpn-cli admin --list

  # Add panel
  vpn-cli panel --add --url http://1.2.3.4:2053 --user admin --pass secret --sub-port 2053 --sub-path sub

  # Check status
  vpn-cli status

  # Check detailed status
  vpn-cli status --verbose
`);
}
// Run the CLI
main().catch((error) => {
    console.error('Error:', error.message);
    process.exit(1);
});
//# sourceMappingURL=index.js.map