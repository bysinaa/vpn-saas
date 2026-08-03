#!/usr/bin/env node

/**
 * TAZAXY CLI - Production installation and management entrypoint.
 */
import * as fs from 'fs';
import * as path from 'path';
import { InstallCommand, type InstallOptions } from './commands/install.3xui';
import { AdminCommand, type AdminOptions } from './commands/admin';
import { PanelCommand, type PanelOptions } from './commands/panel';
import { StatusCommand, type StatusOptions } from './commands/status';
import { PaymentCommand, type PaymentOptions } from './commands/payment';
import { MaintenanceCommand, type MaintenanceOptions } from './commands/maintenance';
import { InfrastructureCommand, type InfrastructureOptions } from './commands/infrastructure';

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
  | 'infrastructure'
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
 
     case 'infrastructure':
     case 'infra':
     case 'db':
       await new InfrastructureCommand().execute(options as InfrastructureOptions);
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
         case 'infrastructure':
           await new InfrastructureCommand().execute({});
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

/**
 * Discovery-first interactive menu.
 *
 * Reads installer-state.json, checks for .env, detects Docker containers,
 * and shows a context-aware menu with status indicators (✅/❌/⚠️).
 * The menu adapts based on what's already installed/configured.
 */
async function promptMenuSelection(): Promise<MenuAction> {
  const readline = await import('readline');

  // ── Discovery ───────────────────────────────────────────────────
  const state = loadInstallerState();
  const envExists = fs.existsSync(path.join(workspaceRoot, '.env'));
  const dockerState = await detectDockerState();

  // Derive installation status from discovery data
  const xuiDetected = state?.xui?.detected === true || dockerState.xuiContainerRunning;
  const xuiConfirmed = !!state?.xui?.confirmed;
  const dbDiscovered = !!state?.db?.discovered;
  const configWritten = !!state?.config?.written;
  const healthChecked = !!state?.health;
  const appRunning = dockerState.appContainerRunning;
  const fullyInstalled = envExists && xuiDetected && dbDiscovered && configWritten;

  // ── Status icons ────────────────────────────────────────────────
  const icon = (ok: boolean) => (ok ? '\x1b[32m✅\x1b[0m' : '\x1b[31m❌\x1b[0m');
  const warn = '\x1b[33m⚠️\x1b[0m';

  // ── Build dynamic menu ──────────────────────────────────────────
  type MenuItem = { label: string; action: MenuAction };
  const items: MenuItem[] = [];

  // 1. Install / Repair
  if (fullyInstalled) {
    items.push({ label: 'Repair / Reconfigure Platform', action: 'install' });
  } else if (envExists) {
    items.push({ label: 'Continue Installation (incomplete)', action: 'install' });
  } else {
    items.push({ label: 'Install Platform', action: 'install' });
  }

  // 2. Edit .env (only if it exists)
  if (envExists) {
    items.push({ label: 'Edit .env File', action: 'editEnv' });
  }

  // 3. Health Status
  {
    const healthIcon = healthChecked
      ? state?.health?.value?.overall === 'healthy'
        ? icon(true)
        : warn
      : icon(false);
    items.push({ label: `${healthIcon} Health Status`, action: 'status' });
  }

  // 4. Super Admin
  items.push({ label: 'Configure Super Admin', action: 'admin' });

  // 5. 3X-UI Panel
  {
    const panelIcon = xuiConfirmed ? icon(true) : xuiDetected ? warn : icon(false);
    const panelLabel = xuiConfirmed
      ? '3X-UI Panel (configured)'
      : xuiDetected
        ? '3X-UI Panel (detected, unconfirmed)'
        : '3X-UI Panel (not detected)';
    items.push({ label: `${panelIcon} ${panelLabel}`, action: 'panel' });
  }

  // 6. Start Services
  {
    const startIcon = appRunning ? icon(true) : icon(false);
    items.push({ label: `${startIcon} Start Services`, action: 'start' });
  }

  // 7. Stop Services
  if (appRunning) {
    items.push({ label: 'Stop Services', action: 'stop' });
  }

  // 8. Restart Services
  if (appRunning) {
    items.push({ label: 'Restart Services', action: 'restart' });
  }

  // 9. View Logs
  if (appRunning) {
    items.push({ label: 'View Logs', action: 'logs' });
  }

  // 10. Payment Gateways
  items.push({ label: 'Payment Gateways', action: 'payments' });

  // 11. Infrastructure (PostgreSQL)
  {
    const dbIcon = dbDiscovered ? icon(true) : icon(false);
    items.push({ label: `${dbIcon} Infrastructure (PostgreSQL)`, action: 'infrastructure' });
  }

  // 12. Check for Updates
  items.push({ label: 'Check for Updates', action: 'update' });

  // 13. Install 3X-UI (standalone)
  {
    const xuiStandaloneIcon = dockerState.xuiContainerRunning ? icon(true) : icon(false);
    items.push({ label: `${xuiStandaloneIcon} Install / Repair 3X-UI`, action: 'install3xui' });
  }

  // 14. Full Uninstall
  items.push({ label: 'Full Uninstall', action: 'uninstall' });

  // 15. Exit
  items.push({ label: 'Exit', action: 'exit' });

  // ── Render menu ─────────────────────────────────────────────────
  console.log('');
  console.log('\x1b[36m╔══════════════════════════════════════════════════════════════╗\x1b[0m');
  console.log('\x1b[36m║          🔧 Tazaxy CLI v2.0.0 — Discovery Menu              ║\x1b[0m');
  console.log('\x1b[36m╚══════════════════════════════════════════════════════════════╝\x1b[0m');
  console.log('');

  // Show discovery summary
  console.log('  Discovery Summary:');
  console.log(`    ${icon(envExists)} .env file          ${envExists ? 'found' : 'missing'}`);
  console.log(`    ${icon(dbDiscovered)} PostgreSQL         ${dbDiscovered ? 'discovered' : 'not discovered'}`);
  console.log(`    ${xuiConfirmed ? icon(true) : xuiDetected ? warn : icon(false)} 3X-UI Panel       ${xuiConfirmed ? `confirmed (${state?.xui?.confirmed?.baseUrl})` : xuiDetected ? 'detected (unconfirmed)' : 'not detected'}`);
  console.log(`    ${icon(appRunning)} App Container      ${appRunning ? 'running' : 'stopped'}`);
  console.log(`    ${icon(dockerState.redisContainerRunning)} Redis Container    ${dockerState.redisContainerRunning ? 'running' : 'stopped'}`);
  console.log(`    ${icon(dockerState.minioContainerRunning)} MinIO Container    ${dockerState.minioContainerRunning ? 'running' : 'stopped'}`);
  if (healthChecked) {
    const overall = state?.health?.value?.overall;
    const healthIcon = overall === 'healthy' ? icon(true) : warn;
    console.log(`    ${healthIcon} Health             ${overall || 'unknown'}`);
  }
  console.log('');

  // Show menu items
  items.forEach((item, idx) => {
    const num = String(idx + 1).padStart(2, ' ');
    console.log(`  ${num}. ${item.label}`);
  });
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const maxNum = items.length;
  const answer = await new Promise<string>((resolve) => {
    rl.question(`Select an action (1-${maxNum}): `, (value) => {
      rl.close();
      resolve(value.trim());
    });
  });

  const idx = parseInt(answer, 10) - 1;
  if (idx >= 0 && idx < items.length) {
    return items[idx].action;
  }
  return 'exit';
}

/**
 * Load installer-state.json (if it exists) and return the parsed state.
 */
function loadInstallerState(): Record<string, any> | null {
  const statePath = path.join(workspaceRoot, 'installer-state.json');
  try {
    if (!fs.existsSync(statePath)) return null;
    const content = fs.readFileSync(statePath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Detect Docker container states by running `docker ps`.
 * Returns flags for app, redis, minio, postgres, and 3x-ui containers.
 */
async function detectDockerState(): Promise<{
  appContainerRunning: boolean;
  redisContainerRunning: boolean;
  minioContainerRunning: boolean;
  postgresContainerRunning: boolean;
  xuiContainerRunning: boolean;
}> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  const result = {
    appContainerRunning: false,
    redisContainerRunning: false,
    minioContainerRunning: false,
    postgresContainerRunning: false,
    xuiContainerRunning: false,
  };

  try {
    const { stdout } = await execAsync('docker ps --format "{{.Names}}||{{.Image}}"', {
      timeout: 5000,
      windowsHide: true,
    });
    const lines = stdout.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const [name, image] = line.split('||');
      const lower = `${name} ${image}`.toLowerCase();
      if (lower.includes('tazaxy-app') || lower.includes('app') && lower.includes('tazaxy')) {
        result.appContainerRunning = true;
      }
      if (lower.includes('redis')) {
        result.redisContainerRunning = true;
      }
      if (lower.includes('minio')) {
        result.minioContainerRunning = true;
      }
      if (lower.includes('postgres') || lower.includes('pg')) {
        result.postgresContainerRunning = true;
      }
      if (lower.includes('xui') || lower.includes('3x-ui') || lower.includes('x-ui')) {
        result.xuiContainerRunning = true;
      }
    }
  } catch {
    // Docker not available or not running — all flags stay false
  }

  return result;
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
    '/opt/tazaxy',
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
  infrastructure     Detect, connect, install, backup and restore PostgreSQL
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
  --sub-port <port>  Subscription port
  --sub-path <path>  Subscription path
`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  });
}

export { main, parseOptions };
