#!/usr/bin/env node

/**
 * VPN SaaS CLI - Production installation and management entrypoint.
 */
import { InstallCommand, type InstallOptions } from './commands/install.3xui';
import { AdminCommand, type AdminOptions } from './commands/admin';
import { PanelCommand, type PanelOptions } from './commands/panel';
import { StatusCommand, type StatusOptions } from './commands/status';

type ParsedOptions = Record<string, unknown>;

type MenuAction =
  | 'install'
  | 'status'
  | 'admin'
  | 'panel'
  | 'start'
  | 'stop'
  | 'restart'
  | 'logs'
  | 'exit';

const args = process.argv.slice(2);
const command = args[0];
const options = parseOptions(args.slice(1));

async function main() {
  console.log('\n🔧 Tazaxy CLI v2.0.0\n');

  switch (command) {
    case 'install':
    case 'i':
      await new InstallCommand().execute(options as InstallOptions);
      break;

    case 'admin':
    case 'admins':
    case 'a':
      await new AdminCommand().execute(options as AdminOptions);
      break;

    case 'panel':
    case 'panels':
    case 'p':
      await new PanelCommand().execute(options as PanelOptions);
      break;

    case 'status':
    case 'health':
    case 's':
      await new StatusCommand().execute(options as StatusOptions);
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

function parseOptions(argv: string[]): ParsedOptions {
  const opts: ParsedOptions = {};
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

function toCamelCase(input: string): string {
  return input.replace(/-([a-z])/g, (_, character: string) => character.toUpperCase());
}

async function showInteractiveMenu() {
  const action = await promptMenuSelection();

  switch (action) {
    case 'install':
      await new InstallCommand().execute(options as InstallOptions);
      return;
    case 'status':
      await new StatusCommand().execute(options as StatusOptions);
      return;
    case 'admin':
      await new AdminCommand().execute(options as AdminOptions);
      return;
    case 'panel':
      await new PanelCommand().execute(options as PanelOptions);
      return;
    case 'start':
      await runComposeCommand('up -d');
      return;
    case 'stop':
      await runComposeCommand('stop');
      return;
    case 'restart':
      await runComposeCommand('restart');
      return;
    case 'logs':
      await runComposeCommand('logs --tail=100');
      return;
    case 'exit':
    default:
      console.log('Exiting Tazaxy CLI.');
  }
}

async function promptMenuSelection(): Promise<MenuAction> {
  const readline = await import('readline');

  console.log('Tazaxy CLI');
  console.log('');
  console.log('1. Install Platform');
  console.log('2. Health Status');
  console.log('3. Configure Super Admin');
  console.log('4. Configure 3X-UI');
  console.log('5. Start Services');
  console.log('6. Stop Services');
  console.log('7. Restart Services');
  console.log('8. View Logs');
  console.log('9. Exit');
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question('Select an action (1-9): ', (value) => {
      rl.close();
      resolve(value.trim());
    });
  });

  switch (answer) {
    case '1':
      return 'install';
    case '2':
      return 'status';
    case '3':
      return 'admin';
    case '4':
      return 'panel';
    case '5':
      return 'start';
    case '6':
      return 'stop';
    case '7':
      return 'restart';
    case '8':
      return 'logs';
    default:
      return 'exit';
  }
}

async function runComposeCommand(subCommand: string) {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  console.log(`Running: docker compose ${subCommand}`);

  const { stdout, stderr } = await execAsync(`docker compose ${subCommand}`, {
    cwd: process.cwd(),
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 10,
  });

  if (stdout.trim()) {
    console.log(stdout.trim());
  }

  if (stderr.trim()) {
    console.error(stderr.trim());
  }
}

function showHelp() {
  console.log(`
Tazaxy CLI - Production installation and management

USAGE:
  tazaxy <command> [options]

COMMANDS:
  install, i         Install or repair the platform
  admin, a           Manage super admin Telegram IDs
  panel, p           Discover and configure 3X-UI panel runtime
  status, s          Show health and runtime status
  menu, m            Show interactive management menu
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

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});