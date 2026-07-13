/**
 * Shared CLI foundation for production installation and management commands.
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as crypto from 'crypto';

const execAsync = promisify(exec);

export type LogLevel = 'info' | 'success' | 'error' | 'warn' | 'debug';

export interface InstallOptions {
  yes?: boolean;
  skip3xui?: boolean;
  panelUrl?: string;
  panelUser?: string;
  panelPass?: string;
  interactive?: boolean;
  verbose?: boolean;
  domain?: string;
  email?: string;
  force?: boolean;
}

export interface InstallContext {
  serverIp: string;
  panelUrl: string;
  panelUser: string;
  panelPass: string;
  subPath: string;
  subPort: number;
  botToken: string;
  databaseUrl: string;
  redisUrl: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  ok: boolean;
}

export interface ExecOptions {
  cwd?: string;
  timeout?: number;
  allowFailure?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface LinuxPlatformInfo {
  distro: string;
  version: string;
  family: 'debian' | 'rhel' | 'unknown';
  architecture: string;
  kernel: string;
}

export interface PortProbeResult {
  port: number;
  inUse: boolean;
  description?: string;
}

export interface VpnSaasPanelRuntimeConfig {
  panelUrl: string;
  panelUser: string;
  panelPass: string;
  apiUrl: string;
  subscriptionBaseUrl: string;
  subscriptionPath: string;
  subscriptionPort: number;
  tlsEnabled: boolean;
  webRoot?: string;
  reverseProxy?: string;
  installationDirectory?: string;
  importedAt?: string;
  updatedAt: string;
  token?: string;
  tokenExpiresAt?: string;
  metadata?: Record<string, unknown>;
}

export interface VpnSaasPlatformConfig {
  version: number;
  installedAt?: string;
  updatedAt: string;
  platform?: LinuxPlatformInfo;
  app?: {
    domain?: string;
    publicIp?: string;
    apiPort: number;
    webPort: number;
    webSecurePort: number;
  };
  superAdmins: string[];
  telegram?: {
    botToken?: string;
    webhookUrl?: string;
    useWebhook?: boolean;
  };
  panel?: VpnSaasPanelRuntimeConfig;
  backup?: {
    directory: string;
    lastBackupAt?: string;
  };
  paths: {
    envFile: string;
    installLogFile: string;
    stateFile: string;
  };
}

export interface MenuChoice<T extends string = string> {
  value: T;
  label: string;
}

export abstract class BaseCommand {
  protected readonly workspaceRoot = process.cwd();
  protected readonly runtimeDir = path.join(this.workspaceRoot, '.vpn-saas');
  protected readonly runtimeConfigPath = path.join(this.runtimeDir, 'config.json');
  protected readonly installLogPath = path.join(this.runtimeDir, 'installer.log');
  protected readonly defaultEnvPath = path.join(this.workspaceRoot, '.env');
  protected verbose = false;
  protected autoApprove = false;

  protected setExecutionMode(options?: { verbose?: boolean; yes?: boolean }) {
    this.verbose = Boolean(options?.verbose);
    this.autoApprove = Boolean(options?.yes);
  }

  protected log(message: string, type: LogLevel = 'info') {
    const prefix = {
      info: '\x1b[36mℹ\x1b[0m',
      success: '\x1b[32m✔\x1b[0m',
      error: '\x1b[31m✖\x1b[0m',
      warn: '\x1b[33m⚠\x1b[0m',
      debug: '\x1b[90m•\x1b[0m',
    }[type];

    if (type === 'debug' && !this.verbose) {
      return;
    }

    console.log(`${prefix} ${message}`);
    void this.appendInstallLog(`[${new Date().toISOString()}] [${type.toUpperCase()}] ${message}\n`);
  }

  protected section(title: string) {
    console.log(`\n\x1b[1m${title}\x1b[0m`);
    console.log('─'.repeat(Math.max(title.length, 40)));
    void this.appendInstallLog(`\n=== ${title} ===\n`);
  }

  protected async prompt(question: string, defaultValue = ''): Promise<string> {
    if (this.autoApprove && defaultValue) {
      this.log(`${question}: ${defaultValue} (auto)`, 'debug');
      return defaultValue;
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      const suffix = defaultValue ? ` [default: ${defaultValue}]` : '';
      rl.question(`❓ ${question}${suffix}: `, (answer) => {
        rl.close();
        resolve(answer.trim() || defaultValue);
      });
    });
  }

  protected async promptSecret(question: string): Promise<string> {
    if (this.autoApprove) {
      return '';
    }

    return this.prompt(question);
  }

  protected async confirm(question: string, defaultValue = false): Promise<boolean> {
    if (this.autoApprove) {
      this.log(`${question}: ${defaultValue ? 'yes' : 'no'} (auto)`, 'debug');
      return defaultValue;
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const suffix = defaultValue ? ' [Y/n]' : ' [y/N]';
    return new Promise((resolve) => {
      rl.question(`❓ ${question}${suffix}: `, (answer) => {
        rl.close();
        const normalized = answer.toLowerCase().trim();
        if (!normalized) {
          resolve(defaultValue);
          return;
        }
        resolve(['y', 'yes'].includes(normalized));
      });
    });
  }

  protected async select<T extends string>(
    question: string,
    options: MenuChoice<T>[],
    defaultValue?: T,
  ): Promise<T> {
    if (options.length === 0) {
      throw new Error('select() requires at least one option');
    }

    console.log(`\n❓ ${question}`);
    options.forEach((opt, index) => {
      const marker = defaultValue && opt.value === defaultValue ? ' (default)' : '';
      console.log(`  ${index + 1}. ${opt.label}${marker}`);
    });

    if (this.autoApprove) {
      return defaultValue ?? options[0].value;
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      rl.question(`\nEnter choice (1-${options.length}): `, (answer) => {
        rl.close();
        const index = Number.parseInt(answer.trim(), 10) - 1;
        if (Number.isInteger(index) && index >= 0 && index < options.length) {
          resolve(options[index].value);
          return;
        }
        resolve(defaultValue ?? options[0].value);
      });
    });
  }

  protected async execCommand(cmd: string, options: ExecOptions = {}): Promise<ExecResult> {
    this.log(`$ ${cmd}`, 'debug');

    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: options.cwd || this.workspaceRoot,
        timeout: options.timeout || 120000,
        env: {
          ...process.env,
          ...options.env,
        },
        windowsHide: true,
        maxBuffer: 1024 * 1024 * 10,
      });

      return {
        stdout,
        stderr,
        exitCode: 0,
        ok: true,
      };
    } catch (error: any) {
      const result: ExecResult = {
        stdout: error?.stdout || '',
        stderr: error?.stderr || error?.message || 'Unknown command error',
        exitCode: typeof error?.code === 'number' ? error.code : 1,
        ok: false,
      };

      if (!options.allowFailure) {
        this.log(`Command failed (${result.exitCode}): ${cmd}`, 'debug');
        if (result.stderr) {
          this.log(result.stderr.trim(), 'debug');
        }
      }

      return result;
    }
  }

  protected async execOrThrow(cmd: string, options: ExecOptions = {}): Promise<ExecResult> {
    const result = await this.execCommand(cmd, options);
    if (!result.ok) {
      throw new Error(result.stderr || `Command failed: ${cmd}`);
    }
    return result;
  }

  protected async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  protected async ensureDir(dirPath: string): Promise<void> {
    await fs.promises.mkdir(dirPath, { recursive: true });
  }

  protected async readFile(filePath: string): Promise<string> {
    return fs.promises.readFile(filePath, 'utf-8');
  }

  protected async writeFile(filePath: string, content: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(filePath, content, 'utf-8');
  }

  protected async appendFile(filePath: string, content: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.appendFile(filePath, content, 'utf-8');
  }

  protected async appendInstallLog(content: string): Promise<void> {
    try {
      await this.appendFile(this.installLogPath, content);
    } catch {
      // ignore logging failures
    }
  }

  protected async detectLinuxPlatform(): Promise<LinuxPlatformInfo> {
    const osReleasePath = '/etc/os-release';
    const uname = await this.execCommand('uname -m', { allowFailure: true });
    const kernel = await this.execCommand('uname -r', { allowFailure: true });

    let distro = 'unknown';
    let version = 'unknown';
    let family: LinuxPlatformInfo['family'] = 'unknown';

    if (await this.fileExists(osReleasePath)) {
      const raw = await this.readFile(osReleasePath);
      const lines = Object.fromEntries(
        raw
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .filter((line) => line.includes('='))
          .map((line) => {
            const [key, ...rest] = line.split('=');
            return [key, rest.join('=').replace(/^"/, '').replace(/"$/, '')];
          }),
      );

      distro = lines.ID || lines.NAME || distro;
      version = lines.VERSION_ID || lines.VERSION || version;

      if (['ubuntu', 'debian', 'linuxmint'].includes(distro)) {
        family = 'debian';
      } else if (['centos', 'rhel', 'rocky', 'almalinux', 'fedora'].includes(distro)) {
        family = 'rhel';
      }
    }

    return {
      distro,
      version,
      family,
      architecture: uname.stdout.trim() || process.arch,
      kernel: kernel.stdout.trim() || 'unknown',
    };
  }

  protected isRootUser(): boolean {
    return typeof process.getuid === 'function' ? process.getuid() === 0 : process.env.USER === 'root';
  }

  protected async detectPublicIp(): Promise<string> {
    const commands = [
      'curl -fsS https://api.ipify.org',
      'curl -fsS https://ifconfig.me',
      'hostname -I | awk \'{print $1}\'',
    ];

    for (const command of commands) {
      const result = await this.execCommand(command, { allowFailure: true, timeout: 20000 });
      const value = result.stdout.trim();
      if (value) {
        return value;
      }
    }

    return '127.0.0.1';
  }

  protected async findAvailablePort(preferred: number, fallbackStart = preferred): Promise<number> {
    const preferredStatus = await this.inspectPort(preferred);
    if (!preferredStatus.inUse) {
      return preferred;
    }

    for (let port = fallbackStart; port < fallbackStart + 200; port += 1) {
      const status = await this.inspectPort(port);
      if (!status.inUse) {
        return port;
      }
    }

    throw new Error(`Unable to find free port near ${preferred}`);
  }

  protected async inspectPort(port: number): Promise<PortProbeResult> {
    const result = await this.execCommand(
      `sh -c "ss -ltnp '( sport = :${port} )' 2>/dev/null || netstat -ltnp 2>/dev/null | grep ':${port} '"`,
      { allowFailure: true },
    );
    const output = `${result.stdout}\n${result.stderr}`.trim();

    return {
      port,
      inUse: Boolean(output),
      description: output || undefined,
    };
  }

  protected async loadRuntimeConfig(): Promise<VpnSaasPlatformConfig> {
    if (!(await this.fileExists(this.runtimeConfigPath))) {
      return {
        version: 1,
        updatedAt: new Date().toISOString(),
        superAdmins: [],
        backup: {
          directory: path.join(this.workspaceRoot, 'backups'),
        },
        paths: {
          envFile: this.defaultEnvPath,
          installLogFile: this.installLogPath,
          stateFile: this.runtimeConfigPath,
        },
      };
    }

    const raw = await this.readFile(this.runtimeConfigPath);
    const parsed = JSON.parse(raw) as VpnSaasPlatformConfig;

    return {
      ...parsed,
      version: 1,
      superAdmins: Array.from(new Set(parsed.superAdmins || [])),
      backup: parsed.backup || {
        directory: path.join(this.workspaceRoot, 'backups'),
      },
      paths: {
        ...(parsed.paths || {}),
        envFile: this.defaultEnvPath,
        installLogFile: this.installLogPath,
        stateFile: this.runtimeConfigPath,
      },
    };
  }

  protected async saveRuntimeConfig(
    updater:
      | VpnSaasPlatformConfig
      | ((config: VpnSaasPlatformConfig) => VpnSaasPlatformConfig | Promise<VpnSaasPlatformConfig>),
  ): Promise<VpnSaasPlatformConfig> {
    const current = await this.loadRuntimeConfig();
    const next =
      typeof updater === 'function'
        ? await updater(current)
        : updater;

    const normalized: VpnSaasPlatformConfig = {
      ...next,
      version: 1,
      updatedAt: new Date().toISOString(),
      superAdmins: Array.from(new Set(next.superAdmins || [])),
      paths: {
        ...(next.paths || {}),
        envFile: this.defaultEnvPath,
        installLogFile: this.installLogPath,
        stateFile: this.runtimeConfigPath,
      },
    };

    await this.ensureDir(this.runtimeDir);
    await this.writeFile(this.runtimeConfigPath, `${JSON.stringify(normalized, null, 2)}\n`);
    return normalized;
  }

  protected buildSubscriptionUrl(config: VpnSaasPanelRuntimeConfig, subId: string, html = false): string {
    const base = config.subscriptionBaseUrl.replace(/\/+$/, '');
    const subPath = config.subscriptionPath.replace(/^\/+/, '').replace(/\/+$/, '');
    const url = `${base}/${subPath}/${subId}`;
    return html ? `${url}?html=1` : url;
  }

  protected generateSecret(length = 32): string {
    return crypto.randomBytes(length).toString('hex').slice(0, length);
  }

  protected upsertEnvValue(content: string, key: string, value: string): string {
    const escapedValue = value.includes('\n') ? JSON.stringify(value) : value;
    const line = `${key}=${escapedValue}`;
    const regex = new RegExp(`^${key}=.*$`, 'm');

    if (regex.test(content)) {
      return content.replace(regex, line);
    }

    return `${content.trimEnd()}\n${line}\n`;
  }

  protected normalizePathSegment(segment: string, fallback: string): string {
    const normalized = (segment || fallback).trim().replace(/^\/+/, '').replace(/\/+$/, '');
    return normalized || fallback;
  }
}