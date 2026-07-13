#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * VPN SaaS CLI - Production installation and management entrypoint.
 */
const install_3xui_1 = require("./commands/install.3xui");
const admin_1 = require("./commands/admin");
const panel_1 = require("./commands/panel");
const status_1 = require("./commands/status");
const args = process.argv.slice(2);
const command = args[0];
const options = parseOptions(args.slice(1));
async function main() {
    console.log('\n🔧 VPN SaaS CLI v2.0.0\n');
    switch (command) {
        case 'install':
        case 'i':
            await new install_3xui_1.InstallCommand().execute(options);
            break;
        case 'admin':
        case 'admins':
        case 'a':
            await new admin_1.AdminCommand().execute(options);
            break;
        case 'panel':
        case 'panels':
        case 'p':
            await new panel_1.PanelCommand().execute(options);
            break;
        case 'status':
        case 'health':
        case 's':
            await new status_1.StatusCommand().execute(options);
            break;
        case 'menu':
        case 'm':
        case undefined:
            await showInteractiveMenu();
            break;
        case 'help':
        case 'h':
        case '--help':
            showHelp();
            break;
        default:
            console.log(`Unknown command: ${command}\n`);
            showHelp();
            process.exitCode = 1;
    }
}
function parseOptions(argv) {
    const opts = {};
    let index = 0;
    while (index < argv.length) {
        const arg = argv[index];
        if (arg.startsWith('--')) {
            const key = toCamelCase(arg.slice(2));
            const nextArg = argv[index + 1];
            if (!nextArg || nextArg.startsWith('-')) {
                opts[key] = true;
                index += 1;
                continue;
            }
            opts[key] = /^\d+$/.test(nextArg) ? Number.parseInt(nextArg, 10) : nextArg;
            index += 2;
            continue;
        }
        if (arg.startsWith('-')) {
            const flags = arg.slice(1).split('');
            flags.forEach((flag) => {
                switch (flag) {
                    case 'y':
                        opts.yes = true;
                        break;
                    case 'v':
                        opts.verbose = true;
                        break;
                    case 'h':
                        opts.help = true;
                        break;
                    default:
                        opts[flag] = true;
                }
            });
            index += 1;
            continue;
        }
        index += 1;
    }
    return opts;
}
function toCamelCase(input) {
    return input.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
}
async function showInteractiveMenu() {
    console.log('VPN SaaS CLI');
    console.log('');
    console.log('1. Install Platform');
    console.log('2. Update Platform');
    console.log('3. Start Services');
    console.log('4. Stop Services');
    console.log('5. Restart Services');
    console.log('6. View Logs');
    console.log('7. Health Status');
    console.log('8. Configure Super Admin');
    console.log('9. Configure Telegram');
    console.log('10. Configure 3X-UI');
    console.log('11. Backup');
    console.log('12. Restore');
    console.log('13. Exit');
    console.log('');
    console.log('Use one of the dedicated commands, for example:');
    console.log('  vpn-cli install --yes');
    console.log('  vpn-cli status --verbose');
    console.log('  vpn-cli admin --add 123456789');
    console.log('  vpn-cli panel --discover --url http://127.0.0.1:2053 --user admin --pass secret');
}
function showHelp() {
    console.log(`
VPN SaaS CLI - Production installation and management

USAGE:
  vpn-cli <command> [options]

COMMANDS:
  install, i         Install or repair the platform
  admin, a           Manage super admin Telegram IDs
  panel, p           Discover and configure 3X-UI panel runtime
  status, s          Show health and runtime status
  menu, m            Show management menu
  help, h            Show help

GLOBAL OPTIONS:
  --yes, -y          Auto-approve prompts when safe
  --verbose, -v      Enable verbose command logging

INSTALL OPTIONS:
  --skip-3xui        Skip fresh 3X-UI installation
  --panel-url        Existing panel URL
  --panel-user       Existing panel username
  --panel-pass       Existing panel password
  --domain           Public domain name
  --email            Administrative email

ADMIN OPTIONS:
  --list             List super admins
  --add <id>         Add super admin
  --remove <id>      Remove super admin
  --change <id>      Set primary super admin

PANEL OPTIONS:
  --list             Show runtime panel configuration
  --add              Add or update panel configuration
  --discover         Discover runtime panel settings automatically
  --test             Validate panel connectivity
  --remove           Remove saved panel configuration
  --url <url>        Panel URL
  --user <user>      Panel username
  --pass <pass>      Panel password
  --sub-port <port>  Subscription port
  --sub-path <path>  Subscription path
`);
}
main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map