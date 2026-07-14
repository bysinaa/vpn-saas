#!/usr/bin/env node

/**
 * VPN SaaS CLI - Production installation and management entrypoint.
 */
import * as fs from 'fs';
import * as path from 'path';
import { InstallCommand, type InstallOptions } from './commands/install.3xui';
import { AdminCommand, type AdminOptions } from './commands/admin';
import { PanelCommand, type PanelOptions } from './commands/panel';
import { StatusCommand, type StatusOptions } from './commands/status';
import { PaymentCommand, type PaymentOptions } from './commands/payment';
import { MaintenanceCommand, type MaintenanceOptions } from './commands/maintenance';

type ParsedOptions = Record<string, unknown>;

type MenuAction =
  | 'install'
  | 'editEnv'
  | 'status'
  | 'admin'
  | 'panel'
  | 'start'
  | 'stop'
  | 'restart'
  | 'logs'
  | 'payments'
  | 'update'
  | 'install3xui'
  | 'uninstall'
  | 'exit';

const args = process.argv.slice(2);
const command = args[0];
const options = parseOptions(args.slice(1));
const workspaceRoot = resolveWorkspaceRoot();
process.chdir(workspaceRoot);

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

    case 'payments':
    case 'payment':
      await new PaymentCommand().execute(options as PaymentOptions);
      break;

    case 'status':
    case 'health':
    case 's':
      await new StatusCommand().execute(options as StatusOptions);
      break;

    case 'update':
      await new MaintenanceCommand().execute({ ...(options as MaintenanceOptions), update: true });
      break;

    case 'uninstall':
      await new MaintenanceCommand().execute({ ...(options as MaintenanceOptions), uninstall: true });
      break;

    case 'install-3xui':
    case 'install3xui':
    case 'xui':
      await new MaintenanceCommand().execute({ ...(options as MaintenanceOptions), install3xui: true });
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
  while (true) {
    const action = await promptMenuSelection();

    if (action === 'exit') {
      console.log('Exiting Tazaxy CLI.');
      return;
    }

    try {
      switch (action) {
        case 'install':
          await new InstallCommand().execute(options as InstallOptions);
          break;
        case 'editEnv':
          await manageEnvFile();
          break;
        case 'status':
          await new StatusCommand().execute(options as StatusOptions);
          break;
        case 'admin':
          await new AdminCommand().execute(options as AdminOptions);
          break;
        case 'panel':
          await new PanelCommand().execute(options as PanelOptions);
          break;
        case 'start':
          await runLifecycleAction('start');
          break;
        case 'stop':
          await runLifecycleAction('stop');
          break;
        case 'restart':
          await runLifecycleAction('restart');
          break;
        case 'logs':
          await runComposeCommand('logs --tail=100 app');
          break;
        case 'payments':
          await new PaymentCommand().execute({});
          break;
        case 'update':
          await new MaintenanceCommand().execute({ update: true });
          break;
        case 'install3xui':
          await new MaintenanceCommand().execute({ install3xui: true });
          break;
        case 'uninstall':
          await new MaintenanceCommand().execute({ uninstall: true });
          break;
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
    }

    console.log('');
    console.log('Returning to Tazaxy main menu...');
    console.log('');
  }
}

async function promptMenuSelection(): Promise<MenuAction> {
  const readline = await import('readline');

  const installed = fs.existsSync(path.join(workspaceRoot, '.env'));
  const firstActionLabel = installed ? 'Edit .env File' : 'Install Platform';

  console.log('Tazaxy CLI');
  console.log('');
  console.log(`1. ${firstActionLabel}`);
  console.log('2. Health Status');
  console.log('3. Configure Super Admin');
  console.log('4. Configure 3X-UI');
  console.log('5. Start Services');
  console.log('6. Stop Services');
  console.log('7. Restart Services');
  console.log('8. View Logs');
  console.log('9. Payment Gateways');
  console.log('10. Check for Updates');
  console.log('11. Install 3X-UI');
  console.log('12. Full Uninstall');
  console.log('13. Exit');
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question('Select an action (1-13): ', (value) => {
      rl.close();
      resolve(value.trim());
    });
  });

  switch (answer) {
    case '1':
      return installed ? 'editEnv' : 'install';
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
    case '9':
      return 'payments';
    case '10':
      return 'update';
    case '11':
      return 'install3xui';
    case '12':
      return 'uninstall';
    default:
      return 'exit';
  }
}

async function manageEnvFile() {
  const envPath = path.join(workspaceRoot, '.env');

  if (!fs.existsSync(envPath)) {
    console.log('Environment file not found. Run "Install Platform" first.');
    return;
  }

  const readline = await import('readline');
  const envContent = fs.readFileSync(envPath, 'utf8');

  console.log(`Environment file: ${envPath}`);
  console.log('1. View .env');
  console.log('2. Edit one key');
  console.log('3. Back');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const action = await new Promise<string>((resolve) => {
    rl.question('Select an action (1-3): ', (value) => {
      rl.close();
      resolve(value.trim());
    });
  });

  if (action === '1') {
    console.log('');
    console.log(envContent.trim());
    return;
  }

  if (action !== '2') {
    return;
  }

  const rlEdit = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const key = await new Promise<string>((resolve) => {
    rlEdit.question('Enter env key to edit: ', (value) => resolve(value.trim()));
  });

  if (!key) {
    rlEdit.close();
    return;
  }

  const currentMatch = envContent.match(new RegExp(`^${key}=(.*)$`, 'm'));
  const currentValue = currentMatch?.[1] ?? '';

  const nextValue = await new Promise<string>((resolve) => {
    const suffix = currentValue ? ` [current: ${currentValue}]` : '';
    rlEdit.question(`Enter new value for ${key}${suffix}: `, (value) => resolve(value));
  });

  rlEdit.close();

  const line = `${key}=${nextValue.trim()}`;
  const regex = new RegExp(`^${key}=.*$`, 'm');
  const nextContent = regex.test(envContent)
    ? envContent.replace(regex, line)
    : `${envContent.trimEnd()}\n${line}\n`;

  fs.writeFileSync(envPath, nextContent, 'utf8');
  console.log(`${key} updated in ${envPath}`);
}

async function runLifecycleAction(action: 'start' | 'stop' | 'restart') {
  const envPath = path.join(workspaceRoot, '.env');
  const composeFile = path.join(workspaceRoot, 'docker-compose.yml');

  if (!fs.existsSync(composeFile)) {
    console.log(`docker-compose.yml not found in ${workspaceRoot}`);
    return;
  }

  if (!fs.existsSync(envPath) && action !== 'stop') {
    console.log('Environment file not found. Run "Install Platform" first to generate .env and configure the project.');
    return;
  }

  if (action === 'stop') {
    await runComposeCommand('stop');
    return;
  }

  if (action === 'restart') {
    await runComposeCommand('down');
  }

  await runComposeCommand('build');
  await runComposeCommand('up -d');
  await runPrismaDeploy();
}

async function runComposeCommand(subCommand: string) {
  const envPath = path.join(workspaceRoot, '.env');
  const composeFile = path.join(workspaceRoot, 'docker-compose.yml');
  const command = `docker compose -f "${composeFile}" --env-file "${envPath}" ${subCommand}`;

  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  console.log(`Running: ${command}`);

  const { stdout, stderr } = await execAsync(command, {
    cwd: workspaceRoot,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 10,
  });

  const out = stdout.toString().trim();
  const err = stderr.toString().trim();

  if (out) {
    console.log(out);
  }

  if (err) {
    console.error(err);
  }
}

async function runPrismaDeploy() {
  const envPath = path.join(workspaceRoot, '.env');
  const composeFile = path.join(workspaceRoot, 'docker-compose.yml');
  const command = `docker compose -f "${composeFile}" --env-file "${envPath}" exec -T app npx prisma migrate deploy`;

  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  console.log(`Running: ${command}`);

  const { stdout, stderr } = await execAsync(command, {
    cwd: workspaceRoot,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 10,
  });

  const out = stdout.toString().trim();
  const err = stderr.toString().trim();

  if (out) {
    console.log(out);
  }

  if (err) {
    console.error(err);
  }
}

function resolveWorkspaceRoot(): string {
  const candidates = [
    process.env.TAZAXY_HOME,
    '/opt/vpn-saas',
    path.resolve(__dirname, '..', '..'),
    process.cwd(),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(path.join(candidate, 'docker-compose.yml'))) {
        return candidate;
      }
    } catch {
      // ignore invalid candidate
    }
  }

  return process.cwd();
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
  payments           Configure crypto and card-to-card payment gateways
  status, s          Show health and runtime status
  update             Update the installed project
  install-3xui       Install or repair 3X-UI
  uninstall          Fully uninstall runtime files and launchers
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