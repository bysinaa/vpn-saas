/**
 * Install Command - Install 3x-ui and configure the bot
 */
import { BaseCommand, type InstallOptions } from './install.interface';
export type { InstallOptions };
export declare class InstallCommand extends BaseCommand {
    private readonly XUI_REPO;
    private readonly XUI_TAG;
    private readonly XUI_INSTALL_URL;
    execute(options: InstallOptions): Promise<void>;
    private check3xuiInstalled;
    private get3xuiStatus;
    private handleExisting3xui;
    private handleNew3xui;
    private configure3xui;
    private configureBot;
    private showFinalInstructions;
    private getServerIp;
    private testPanelConnection;
    private syncExistingUsers;
    private savePanelConfig;
    private checkPostgresInstalled;
    private checkRedisInstalled;
    private installPostgres;
    private installRedis;
    private downloadFile;
    private httpRequest;
    private generateEnvFile;
}
//# sourceMappingURL=install.3xui.d.ts.map