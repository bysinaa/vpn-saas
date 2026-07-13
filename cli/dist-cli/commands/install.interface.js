"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseCommand = void 0;
/**
 * Shared CLI foundation for production installation and management commands.
 */
const child_process_1 = require("child_process");
const util_1 = require("util");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const readline = __importStar(require("readline"));
const crypto = __importStar(require("crypto"));
const execAsync = (0, util_1.promisify)(child_process_1.exec);
class BaseCommand {
    constructor() {
        this.workspaceRoot = process.cwd();
        this.runtimeDir = path.join(this.workspaceRoot, '.vpn-saas');
        this.runtimeConfigPath = path.join(this.runtimeDir, 'config.json');
        this.installLogPath = path.join(this.runtimeDir, 'installer.log');
        this.defaultEnvPath = path.join(this.workspaceRoot, '.env');
        this.verbose = false;
        this.autoApprove = false;
    }
    setExecutionMode(options) {
        this.verbose = Boolean(options?.verbose);
        this.autoApprove = Boolean(options?.yes);
    }
    log(message, type = 'info') {
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
    section(title) {
        console.log(`\n\x1b[1m${title}\x1b[0m`);
        console.log('─'.repeat(Math.max(title.length, 40)));
        void this.appendInstallLog(`\n=== ${title} ===\n`);
    }
    async prompt(question, defaultValue = '') {
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
    async promptSecret(question) {
        if (this.autoApprove) {
            return '';
        }
        return this.prompt(question);
    }
    async confirm(question, defaultValue = false) {
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
    async select(question, options, defaultValue) {
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
    async execCommand(cmd, options = {}) {
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
        }
        catch (error) {
            const result = {
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
    async execOrThrow(cmd, options = {}) {
        const result = await this.execCommand(cmd, options);
        if (!result.ok) {
            throw new Error(result.stderr || `Command failed: ${cmd}`);
        }
        return result;
    }
    async fileExists(filePath) {
        try {
            await fs.promises.access(filePath);
            return true;
        }
        catch {
            return false;
        }
    }
    async ensureDir(dirPath) {
        await fs.promises.mkdir(dirPath, { recursive: true });
    }
    async readFile(filePath) {
        return fs.promises.readFile(filePath, 'utf-8');
    }
    async writeFile(filePath, content) {
        const dir = path.dirname(filePath);
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(filePath, content, 'utf-8');
    }
    async appendFile(filePath, content) {
        const dir = path.dirname(filePath);
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.appendFile(filePath, content, 'utf-8');
    }
    async appendInstallLog(content) {
        try {
            await this.appendFile(this.installLogPath, content);
        }
        catch {
            // ignore logging failures
        }
    }
    async detectLinuxPlatform() {
        const osReleasePath = '/etc/os-release';
        const uname = await this.execCommand('uname -m', { allowFailure: true });
        const kernel = await this.execCommand('uname -r', { allowFailure: true });
        let distro = 'unknown';
        let version = 'unknown';
        let family = 'unknown';
        if (await this.fileExists(osReleasePath)) {
            const raw = await this.readFile(osReleasePath);
            const lines = Object.fromEntries(raw
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
                .filter((line) => line.includes('='))
                .map((line) => {
                const [key, ...rest] = line.split('=');
                return [key, rest.join('=').replace(/^"/, '').replace(/"$/, '')];
            }));
            distro = lines.ID || lines.NAME || distro;
            version = lines.VERSION_ID || lines.VERSION || version;
            if (['ubuntu', 'debian', 'linuxmint'].includes(distro)) {
                family = 'debian';
            }
            else if (['centos', 'rhel', 'rocky', 'almalinux', 'fedora'].includes(distro)) {
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
    isRootUser() {
        return typeof process.getuid === 'function' ? process.getuid() === 0 : process.env.USER === 'root';
    }
    async detectPublicIp() {
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
    async findAvailablePort(preferred, fallbackStart = preferred) {
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
    async inspectPort(port) {
        const result = await this.execCommand(`sh -c "ss -ltnp '( sport = :${port} )' 2>/dev/null || netstat -ltnp 2>/dev/null | grep ':${port} '"`, { allowFailure: true });
        const output = `${result.stdout}\n${result.stderr}`.trim();
        return {
            port,
            inUse: Boolean(output),
            description: output || undefined,
        };
    }
    async loadRuntimeConfig() {
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
        const parsed = JSON.parse(raw);
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
    async saveRuntimeConfig(updater) {
        const current = await this.loadRuntimeConfig();
        const next = typeof updater === 'function'
            ? await updater(current)
            : updater;
        const normalized = {
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
    buildSubscriptionUrl(config, subId, html = false) {
        const base = config.subscriptionBaseUrl.replace(/\/+$/, '');
        const subPath = config.subscriptionPath.replace(/^\/+/, '').replace(/\/+$/, '');
        const url = `${base}/${subPath}/${subId}`;
        return html ? `${url}?html=1` : url;
    }
    generateSecret(length = 32) {
        return crypto.randomBytes(length).toString('hex').slice(0, length);
    }
    upsertEnvValue(content, key, value) {
        const escapedValue = value.includes('\n') ? JSON.stringify(value) : value;
        const line = `${key}=${escapedValue}`;
        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (regex.test(content)) {
            return content.replace(regex, line);
        }
        return `${content.trimEnd()}\n${line}\n`;
    }
    normalizePathSegment(segment, fallback) {
        const normalized = (segment || fallback).trim().replace(/^\/+/, '').replace(/\/+$/, '');
        return normalized || fallback;
    }
}
exports.BaseCommand = BaseCommand;
//# sourceMappingURL=install.interface.js.map