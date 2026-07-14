import { BaseCommand } from './install.interface';
export interface InfrastructureOptions {
    detect?: boolean;
    connect?: boolean;
    install?: boolean;
    recreate?: boolean;
    backup?: boolean;
    restore?: boolean;
    show?: boolean;
    url?: string;
    yes?: boolean;
    verbose?: boolean;
    file?: string;
}
export declare class InfrastructureCommand extends BaseCommand {
    private readonly postgresDir;
    private readonly postgresComposeFile;
    private readonly postgresEnvFile;
    private readonly sharedEnvFile;
    private readonly backupDir;
    private readonly vpnDatabase;
    execute(options: InfrastructureOptions): Promise<void>;
    private promptForAction;
    private detectPostgreSQL;
    private connectExistingPostgreSQL;
    private installPostgreSQL;
    private recreateDatabase;
    private backupDatabase;
    private restoreDatabase;
    private showConnection;
    private readMergedEnv;
    private readEnvFile;
    private buildDatabaseUrl;
    private checkDatabaseUrl;
    private detectDockerPostgres;
    private waitForDatabase;
    private ensureDatabaseExists;
    private dropDatabase;
    private updateProjectEnv;
}
//# sourceMappingURL=infrastructure.d.ts.map