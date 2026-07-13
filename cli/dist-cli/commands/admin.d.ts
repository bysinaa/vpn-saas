/**
 * Admin Command - Manage super admin settings
 */
import { BaseCommand } from './install.interface';
export interface AdminOptions {
    list?: boolean;
    add?: string;
    remove?: string;
}
export declare class AdminCommand extends BaseCommand {
    private readonly configPath;
    execute(options: AdminOptions): Promise<void>;
    private loadConfig;
    private saveConfig;
    private listAdmins;
    private addAdmin;
    private removeAdmin;
    private showMenu;
}
//# sourceMappingURL=admin.d.ts.map