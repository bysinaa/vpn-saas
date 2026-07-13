/**
 * Panel Command - Manage 3X-UI panel connections and runtime discovery.
 */
import { BaseCommand } from './install.interface';
export interface PanelOptions {
    add?: boolean;
    remove?: boolean;
    list?: boolean;
    test?: boolean;
    sync?: boolean;
    url?: string;
    user?: string;
    pass?: string;
    subPort?: number;
    subPath?: string;
    discover?: boolean;
}
export declare class PanelCommand extends BaseCommand {
    execute(options: PanelOptions): Promise<void>;
    private listPanels;
    private addPanel;
    private removePanel;
    private testPanel;
    private syncPanel;
    private discoverCurrentPanel;
    private showMenu;
    private discoverPanelRuntime;
    private extractSubscriptionPath;
    private detectInstallationDirectory;
    private detectReverseProxy;
    private login;
    private persistPanelEnv;
    private httpRequest;
}
//# sourceMappingURL=panel.d.ts.map