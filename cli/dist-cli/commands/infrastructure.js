"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.InfrastructureCommand = void 0;
const path = __importStar(require("path"));
const install_interface_1 = require("./install.interface");
class InfrastructureCommand extends install_interface_1.BaseCommand {
    constructor() {
        super(...arguments);
        this.postgresDir = '/opt/postgres';
        this.postgresComposeFile = '/opt/postgres/docker-compose.yml';
        this.postgresEnvFile = '/opt/postgres/.env';
        this.sharedEnvFile = '/opt/shared/.env';
        this.backupDir = '/opt/backups/postgres';
        this.vpnDatabase = 'vpn_saas';
    }
    async execute(options) {
        this.setExecutionMode(options);
        const action = options.detect ? 'detect' :
            options.connect ? 'connect' :
                options.install ? 'install' :
                    options.recreate ? 'recreate' :
                        options.backup ? 'backup' :
                            options.restore ? 'restore' :
                                options.show ? 'show' :
                                    await this.promptForAction();
        this.section('Infrastructure');
        switch (action) {
            case 'detect':
                await this.detectPostgreSQL();
                break;
            case 'connect':
                await this.connectExistingPostgreSQL(options.url);
                break;
            case 'install':
                await this.installPostgreSQL();
                break;
            case 'recreate':
                await this.recreateDatabase();
                break;
            case 'backup':
                await this.backupDatabase();
                break;
            case 'restore':
                await this.restoreDatabase(options.file);
                break;
            case 'show':
                await this.showConnection();
                break;
        }
    }
    async promptForAction() {
        return this.select('Choose infrastructure action', [
            { value: 'detect', label: 'Detect PostgreSQL' },
            { value: 'connect', label: 'Connect existing PostgreSQL' },
            { value: 'install', label: 'Install PostgreSQL' },
            { value: 'recreate', label: 'Recreate database' },
            { value: 'backup', label: 'Backup database' },
            { value: 'restore', label: 'Restore database' },
            { value: 'show', label: 'Show connection' },
        ], 'detect');
    }
    async detectPostgreSQL() {
        const env = await this.readMergedEnv();
        const databaseUrl = env.DATABASE_URL;
        if (databaseUrl) {
            const ok = await this.checkDatabaseUrl(databaseUrl);
            if (ok) {
                this.log(`Detected configured DATABASE_URL`, 'success');
                console.log(databaseUrl);
                return {
                    source: 'database_url',
                    databaseUrl,
                    details: 'Using DATABASE_URL from project/shared environment',
                };
            }
        }
        const localUrl = this.buildDatabaseUrl({
            host: 'localhost',
            port: env.POSTGRES_PORT || '5432',
            user: env.POSTGRES_USER || 'postgres',
            password: env.POSTGRES_PASSWORD || 'postgres',
            database: env.VPN_DATABASE || this.vpnDatabase,
        });
        if (await this.checkDatabaseUrl(localUrl, 'postgres')) {
            this.log('Detected local PostgreSQL on localhost:5432', 'success');
            console.log(localUrl);
            return {
                source: 'local_postgres',
                databaseUrl: localUrl,
                details: 'Detected existing host PostgreSQL service',
            };
        }
        if (await this.detectDockerPostgres(env)) {
            const dockerUrl = this.buildDatabaseUrl({
                host: env.POSTGRES_HOST || 'postgres',
                port: env.POSTGRES_PORT || '5432',
                user: env.POSTGRES_USER || 'postgres',
                password: env.POSTGRES_PASSWORD || 'postgres',
                database: env.VPN_DATABASE || this.vpnDatabase,
            });
            this.log('Detected standalone Docker PostgreSQL', 'success');
            console.log(dockerUrl);
            return {
                source: 'docker_postgres',
                databaseUrl: dockerUrl,
                details: 'Detected Docker PostgreSQL service managed independently',
            };
        }
        this.log('No PostgreSQL instance detected', 'warn');
        return {
            source: 'none',
            details: 'No DATABASE_URL, local PostgreSQL, or Docker PostgreSQL detected',
        };
    }
    async connectExistingPostgreSQL(url) {
        const providedUrl = url || await this.promptRequired('Enter PostgreSQL DATABASE_URL');
        const ok = await this.checkDatabaseUrl(providedUrl);
        if (!ok) {
            throw new Error('Unable to connect to the provided PostgreSQL DATABASE_URL');
        }
        await this.updateProjectEnv('DATABASE_URL', providedUrl);
        this.log('Connected existing PostgreSQL and saved DATABASE_URL', 'success');
    }
    async installPostgreSQL() {
        await this.ensureDir(this.backupDir);
        const dockerCheck = await this.execCommand('docker --version', { allowFailure: true });
        if (!dockerCheck.ok) {
            throw new Error('Docker is required to install standalone PostgreSQL automatically');
        }
        await this.execOrThrow('docker volume create postgres_data', { allowFailure: true });
        await this.execOrThrow(`docker compose -f "${this.postgresComposeFile}" --env-file "${this.postgresEnvFile}" up -d`);
        const env = await this.readMergedEnv();
        const databaseUrl = this.buildDatabaseUrl({
            host: env.POSTGRES_HOST || 'localhost',
            port: env.POSTGRES_PORT || '5432',
            user: env.POSTGRES_USER || 'postgres',
            password: env.POSTGRES_PASSWORD || 'postgres',
            database: env.VPN_DATABASE || this.vpnDatabase,
        });
        await this.waitForDatabase(databaseUrl);
        await this.ensureDatabaseExists(databaseUrl, env.VPN_DATABASE || this.vpnDatabase);
        await this.updateProjectEnv('DATABASE_URL', databaseUrl);
        this.log('Standalone PostgreSQL installed and configured', 'success');
    }
    async recreateDatabase() {
        const env = await this.readMergedEnv();
        const databaseUrl = env.DATABASE_URL || this.buildDatabaseUrl({
            host: env.POSTGRES_HOST || 'localhost',
            port: env.POSTGRES_PORT || '5432',
            user: env.POSTGRES_USER || 'postgres',
            password: env.POSTGRES_PASSWORD || 'postgres',
            database: env.VPN_DATABASE || this.vpnDatabase,
        });
        const databaseName = env.VPN_DATABASE || this.vpnDatabase;
        const confirmed = await this.confirm(`Recreate database "${databaseName}"? This drops and recreates only the VPN SaaS database, not the PostgreSQL service.`, false);
        if (!confirmed) {
            this.log('Database recreation cancelled', 'warn');
            return;
        }
        await this.dropDatabase(databaseUrl, databaseName);
        await this.ensureDatabaseExists(databaseUrl, databaseName);
        this.log(`Database "${databaseName}" recreated`, 'success');
    }
    async backupDatabase() {
        const env = await this.readMergedEnv();
        const databaseUrl = env.DATABASE_URL;
        if (!databaseUrl) {
            throw new Error('DATABASE_URL is required to create a backup');
        }
        await this.ensureDir(this.backupDir);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(this.backupDir, `vpn_saas_${timestamp}.sql`);
        await this.execOrThrow(`pg_dump "${databaseUrl}" > "${backupPath}"`, {
            allowFailure: false,
        });
        this.log(`Backup created: ${backupPath}`, 'success');
        await this.saveRuntimeConfig((config) => ({
            ...config,
            backup: {
                directory: this.backupDir,
                lastBackupAt: new Date().toISOString(),
            },
        }));
    }
    async restoreDatabase(file) {
        const env = await this.readMergedEnv();
        const databaseUrl = env.DATABASE_URL;
        if (!databaseUrl) {
            throw new Error('DATABASE_URL is required to restore a backup');
        }
        const backupFile = file || await this.promptRequired('Enter backup file path');
        const exists = await this.fileExists(backupFile);
        if (!exists) {
            throw new Error(`Backup file not found: ${backupFile}`);
        }
        await this.execOrThrow(`psql "${databaseUrl}" -f "${backupFile}"`);
        this.log(`Database restored from ${backupFile}`, 'success');
    }
    async showConnection() {
        const detection = await this.detectPostgreSQL();
        console.log('');
        console.log(`Source: ${detection.source}`);
        console.log(`Details: ${detection.details}`);
        if (detection.databaseUrl) {
            console.log(`DATABASE_URL: ${detection.databaseUrl}`);
        }
    }
    async readMergedEnv() {
        const projectEnv = await this.readEnvFile(this.defaultEnvPath);
        const sharedEnv = await this.readEnvFile(this.sharedEnvFile);
        return {
            ...sharedEnv,
            ...projectEnv,
            ...Object.fromEntries(Object.entries(process.env)
                .filter((entry) => typeof entry[1] === 'string')),
        };
    }
    async readEnvFile(filePath) {
        if (!(await this.fileExists(filePath))) {
            return {};
        }
        const raw = await this.readFile(filePath);
        const entries = raw
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('#') && line.includes('='))
            .map((line) => {
            const index = line.indexOf('=');
            return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
        });
        return Object.fromEntries(entries);
    }
    buildDatabaseUrl(input) {
        return `postgresql://${input.user}:${input.password}@${input.host}:${input.port}/${input.database}?schema=public`;
    }
    async checkDatabaseUrl(databaseUrl, database = this.vpnDatabase) {
        const escaped = databaseUrl.replace(/"/g, '\\"');
        const result = await this.execCommand(`node -e "const { Client } = require('pg'); const client = new Client({ connectionString: \\"${escaped}\\" }); client.connect().then(() => client.end()).then(() => process.exit(0)).catch(() => process.exit(1));"`, { allowFailure: true });
        if (result.ok) {
            return true;
        }
        const fallback = await this.execCommand(`node -e "const { Client } = require('pg'); const url = new URL(\\"${escaped}\\"); const client = new Client({ host: url.hostname, port: Number(url.port || 5432), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: 'postgres' }); client.connect().then(() => client.end()).then(() => process.exit(0)).catch(() => process.exit(1));"`, { allowFailure: true });
        return fallback.ok && Boolean(database);
    }
    async detectDockerPostgres(env) {
        const dockerCheck = await this.execCommand('docker ps --format "{{.Names}}"', { allowFailure: true });
        if (!dockerCheck.ok) {
            return false;
        }
        const output = dockerCheck.stdout;
        if (/postgres/i.test(output)) {
            return true;
        }
        const composeCheck = await this.execCommand(`docker compose -f "${this.postgresComposeFile}" --env-file "${this.postgresEnvFile}" ps`, { allowFailure: true });
        return composeCheck.ok && /postgres/i.test(composeCheck.stdout);
    }
    async waitForDatabase(databaseUrl) {
        for (let i = 0; i < 30; i += 1) {
            if (await this.checkDatabaseUrl(databaseUrl)) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        throw new Error('PostgreSQL did not become ready in time');
    }
    async ensureDatabaseExists(databaseUrl, databaseName) {
        const adminUrl = new URL(databaseUrl);
        adminUrl.pathname = '/postgres';
        const command = `node -e "const { Client } = require('pg'); ` +
            `const dbName = ${JSON.stringify(databaseName)}; ` +
            `const client = new Client({ connectionString: ${JSON.stringify(adminUrl.toString())} }); ` +
            `client.connect()` +
            `.then(() => client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]))` +
            `.then((res) => res.rows.length ? null : client.query('CREATE DATABASE \"' + dbName.replace(/\"/g, '\"\"') + '\"'))` +
            `.then(() => client.end())` +
            `.then(() => process.exit(0))` +
            `.catch(async (err) => { console.error(err.message); try { await client.end(); } catch {} process.exit(1); });"`;
        await this.execOrThrow(command);
    }
    async dropDatabase(databaseUrl, databaseName) {
        const adminUrl = new URL(databaseUrl);
        adminUrl.pathname = '/postgres';
        const command = `node -e "const { Client } = require('pg'); ` +
            `const dbName = ${JSON.stringify(databaseName)}; ` +
            `const client = new Client({ connectionString: ${JSON.stringify(adminUrl.toString())} }); ` +
            `client.connect()` +
            `.then(() => client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [dbName]))` +
            `.then(() => client.query('DROP DATABASE IF EXISTS \"' + dbName.replace(/\"/g, '\"\"') + '\"'))` +
            `.then(() => client.end())` +
            `.then(() => process.exit(0))` +
            `.catch(async (err) => { console.error(err.message); try { await client.end(); } catch {} process.exit(1); });"`;
        await this.execOrThrow(command);
    }
    async updateProjectEnv(key, value) {
        const current = (await this.fileExists(this.defaultEnvPath))
            ? await this.readFile(this.defaultEnvPath)
            : '';
        const next = this.upsertEnvValue(current, key, value);
        await this.writeFile(this.defaultEnvPath, next);
    }
}
exports.InfrastructureCommand = InfrastructureCommand;
//# sourceMappingURL=infrastructure.js.map