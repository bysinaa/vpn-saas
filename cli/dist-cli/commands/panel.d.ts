/**
 * Panel Command - Manage 3x-UI panel connections
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
}
export declare class PanelCommand extends BaseCommand {
    private readonly configPath;
    execute(options: PanelOptions): Promise<void>;
    private loadConfig;
    private saveConfig;
    private listPanels;
    private addPanel;
    private removePanel;
    private testPanel;
    private syncPanel;
    private showMenu;
    private testPanelConnection;
    private httpRequest;
}
//# sourceMappingURL=panel.d.ts.map