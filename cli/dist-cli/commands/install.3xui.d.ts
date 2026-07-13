/**
 * Production installer for VPN SaaS and 3X-UI integration.
 */
import { BaseCommand, type InstallOptions } from './install.interface';
export type { InstallOptions };
export declare class InstallCommand extends BaseCommand {
    private readonly xuiInstallUrl;
    execute(options: InstallOptions): Promise<void>;
    private validatePlatform;
    private ensureRootPrivileges;
    private ensureDockerInstalled;
    private ensureDockerComposeInstalled;
    private ensureBasePackages;
    private configureFirewall;
    private ensure3xuiRuntime;
    private ensureEnvironment;
    private buildAndStartContainers;
    private runPrismaTasks;
    private ensureSuperAdmin;
    private validateInstallation;
    private showFinalSummary;
}
//# sourceMappingURL=install.3xui.d.ts.map