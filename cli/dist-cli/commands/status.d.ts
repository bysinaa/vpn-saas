/**
 * Status Command - Production runtime health inspection.
 */
import { BaseCommand } from './install.interface';
export interface StatusOptions {
    verbose?: boolean;
}
export declare class StatusCommand extends BaseCommand {
    execute(options: StatusOptions): Promise<void>;
    private checkDocker;
    private checkCompose;
    private check3xui;
    private checkDatabase;
    private checkRedis;
    private checkApplication;
    private checkConfiguredPorts;
}
//# sourceMappingURL=status.d.ts.map