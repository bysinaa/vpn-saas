export interface InstallOptions {
    yes?: boolean;
    skip3xui?: boolean;
    panelUrl?: string;
    panelUser?: string;
    panelPass?: string;
    interactive?: boolean;
}
export interface InstallContext {
    serverIp: string;
    panelUrl: string;
    panelUser: string;
    panelPass: string;
    subPath: string;
    subPort: number;
    botToken: string;
    databaseUrl: string;
    redisUrl: string;
}
export declare abstract class BaseCommand {
    protected log(message: string, type?: 'info' | 'success' | 'error' | 'warn'): void;
    protected prompt(question: string): Promise<string>;
    protected confirm(question: string, defaultValue?: boolean): Promise<boolean>;
    protected select<T extends string>(question: string, options: {
        value: T;
        label: string;
    }[]): Promise<T>;
    protected execCommand(cmd: string, options?: {
        cwd?: string;
        timeout?: number;
    }): Promise<{
        stdout: string;
        stderr: string;
    }>;
    protected fileExists(filePath: string): Promise<boolean>;
    protected readFile(filePath: string): Promise<string>;
    protected writeFile(filePath: string, content: string): Promise<void>;
    protected appendFile(filePath: string, content: string): Promise<void>;
}
//# sourceMappingURL=install.interface.d.ts.map