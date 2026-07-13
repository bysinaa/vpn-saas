/**
 * Admin Command - Manage super admin settings.
 */
import { BaseCommand } from './install.interface';
export interface AdminOptions {
    list?: boolean;
    add?: string;
    remove?: string;
    change?: string;
}
export declare class AdminCommand extends BaseCommand {
    execute(options: AdminOptions): Promise<void>;
    private listAdmins;
    private addAdmin;
    private removeAdmin;
    private changePrimaryAdmin;
    private showMenu;
    private validateTelegramId;
    private persistEnvAdmins;
    private persistAdminsToDatabase;
}
//# sourceMappingURL=admin.d.ts.map