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
export declare abstract class BaseCommand {
    protected readonly workspaceRoot: string;
    protected readonly runtimeDir: string;
    protected readonly runtimeConfigPath: string;
    protected readonly installLogPath: string;
    protected readonly defaultEnvPath: string;
    protected verbose: boolean;
    protected autoApprove: boolean;
    protected setExecutionMode(options?: {
        verbose?: boolean;
        yes?: boolean;
    }): void;
    protected log(message: string, type?: LogLevel): void;
    protected section(title: string): void;
    protected prompt(question: string, defaultValue?: string): Promise<string>;
    protected promptSecret(question: string): Promise<string>;
    protected confirm(question: string, defaultValue?: boolean): Promise<boolean>;
    protected select<T extends string>(question: string, options: MenuChoice<T>[], defaultValue?: T): Promise<T>;
    protected execCommand(cmd: string, options?: ExecOptions): Promise<ExecResult>;
    protected execOrThrow(cmd: string, options?: ExecOptions): Promise<ExecResult>;
    protected fileExists(filePath: string): Promise<boolean>;
    protected ensureDir(dirPath: string): Promise<void>;
    protected readFile(filePath: string): Promise<string>;
    protected writeFile(filePath: string, content: string): Promise<void>;
    protected appendFile(filePath: string, content: string): Promise<void>;
    protected appendInstallLog(content: string): Promise<void>;
    protected detectLinuxPlatform(): Promise<LinuxPlatformInfo>;
    protected isRootUser(): boolean;
    protected detectPublicIp(): Promise<string>;
    protected findAvailablePort(preferred: number, fallbackStart?: number): Promise<number>;
    protected inspectPort(port: number): Promise<PortProbeResult>;
    protected loadRuntimeConfig(): Promise<VpnSaasPlatformConfig>;
    protected saveRuntimeConfig(updater: VpnSaasPlatformConfig | ((config: VpnSaasPlatformConfig) => VpnSaasPlatformConfig | Promise<VpnSaasPlatformConfig>)): Promise<VpnSaasPlatformConfig>;
    protected buildSubscriptionUrl(config: VpnSaasPanelRuntimeConfig, subId: string, html?: boolean): string;
    protected generateSecret(length?: number): string;
    protected upsertEnvValue(content: string, key: string, value: string): string;
    protected normalizePathSegment(segment: string, fallback: string): string;
}
//# sourceMappingURL=install.interface.d.ts.map