import { BaseCommand } from './install.interface';
export interface MaintenanceOptions {
    update?: boolean;
    uninstall?: boolean;
    install3xui?: boolean;
    yes?: boolean;
    verbose?: boolean;
}
export declare class MaintenanceCommand extends BaseCommand {
    private readonly xuiInstallUrl;
    execute(options: MaintenanceOptions): Promise<void>;
    private showMenu;
    private updatePlatform;
    private install3xui;
    private uninstallPlatform;
}
//# sourceMappingURL=maintenance.d.ts.map