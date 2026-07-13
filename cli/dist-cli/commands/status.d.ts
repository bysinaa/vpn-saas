/**
 * Status Command - System health check
 */
import { BaseCommand } from './install.interface';
export interface StatusOptions {
    verbose?: boolean;
}
export declare class StatusCommand extends BaseCommand {
    execute(options: StatusOptions): Promise<void>;
    private check3xui;
    private checkDatabase;
    private checkRedis;
    private checkBotProcess;
    private checkPorts;
}
//# sourceMappingURL=status.d.ts.map