import * as path from 'path';
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

type InfraAction =
  | 'detect'
  | 'connect'
  | 'install'
  | 'recreate'
  | 'backup'
  | 'restore'
  | 'show';

interface DetectionResult {
  source: 'database_url' | 'local_postgres' | 'docker_postgres' | 'none';
  databaseUrl?: string;
  details: string;
}

export class InfrastructureCommand extends BaseCommand {
  private readonly postgresDir = '/opt/postgres';
  private readonly postgresComposeFile = '/opt/postgres/docker-compose.yml';
  private readonly postgresEnvFile = '/opt/postgres/.env';
  private readonly sharedEnvFile = '/opt/shared/.env';
  private readonly backupDir = '/opt/backups/postgres';
  private readonly vpnDatabase = 'vpn_saas';

  async execute(options: InfrastructureOptions): Promise<void> {
    this.setExecutionMode(options);

    const action =
      options.detect ? 'detect' :
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

  private async promptForAction(): Promise<InfraAction> {
    return this.select<InfraAction>('Choose infrastructure action', [
      { value: 'detect', label: 'Detect PostgreSQL' },
      { value: 'connect', label: 'Connect existing PostgreSQL' },
      { value: 'install', label: 'Install PostgreSQL' },
      { value: 'recreate', label: 'Recreate database' },
      { value: 'backup', label: 'Backup database' },
      { value: 'restore', label: 'Restore database' },
      { value: 'show', label: 'Show connection' },
    ], 'detect');
  }

  private async detectPostgreSQL(): Promise<DetectionResult> {
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

  private async connectExistingPostgreSQL(url?: string): Promise<void> {
    const providedUrl = url || await this.promptRequired('Enter PostgreSQL DATABASE_URL');
    const ok = await this.checkDatabaseUrl(providedUrl);

    if (!ok) {
      throw new Error('Unable to connect to the provided PostgreSQL DATABASE_URL');
    }

    await this.updateProjectEnv('DATABASE_URL', providedUrl);
    this.log('Connected existing PostgreSQL and saved DATABASE_URL', 'success');
  }

  private async installPostgreSQL(): Promise<void> {
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

  private async recreateDatabase(): Promise<void> {
    const env = await this.readMergedEnv();
    const databaseUrl = env.DATABASE_URL || this.buildDatabaseUrl({
      host: env.POSTGRES_HOST || 'localhost',
      port: env.POSTGRES_PORT || '5432',
      user: env.POSTGRES_USER || 'postgres',
      password: env.POSTGRES_PASSWORD || 'postgres',
      database: env.VPN_DATABASE || this.vpnDatabase,
    });

    const databaseName = env.VPN_DATABASE || this.vpnDatabase;
    const confirmed = await this.confirm(
      `Recreate database "${databaseName}"? This drops and recreates only the VPN SaaS database, not the PostgreSQL service.`,
      false,
    );

    if (!confirmed) {
      this.log('Database recreation cancelled', 'warn');
      return;
    }

    await this.dropDatabase(databaseUrl, databaseName);
    await this.ensureDatabaseExists(databaseUrl, databaseName);
    this.log(`Database "${databaseName}" recreated`, 'success');
  }

  private async backupDatabase(): Promise<void> {
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

  private async restoreDatabase(file?: string): Promise<void> {
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

  private async showConnection(): Promise<void> {
    const detection = await this.detectPostgreSQL();
    console.log('');
    console.log(`Source: ${detection.source}`);
    console.log(`Details: ${detection.details}`);
    if (detection.databaseUrl) {
      console.log(`DATABASE_URL: ${detection.databaseUrl}`);
    }
  }

  private async readMergedEnv(): Promise<Record<string, string>> {
    const projectEnv = await this.readEnvFile(this.defaultEnvPath);
    const sharedEnv = await this.readEnvFile(this.sharedEnvFile);
    return {
      ...sharedEnv,
      ...projectEnv,
      ...Object.fromEntries(
        Object.entries(process.env)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      ),
    };
  }

  private async readEnvFile(filePath: string): Promise<Record<string, string>> {
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
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()] as const;
      });

    return Object.fromEntries(entries);
  }

  private buildDatabaseUrl(input: {
    host: string;
    port: string;
    user: string;
    password: string;
    database: string;
  }): string {
    return `postgresql://${input.user}:${input.password}@${input.host}:${input.port}/${input.database}?schema=public`;
  }

  private async checkDatabaseUrl(databaseUrl: string, database = this.vpnDatabase): Promise<boolean> {
    const escaped = databaseUrl.replace(/"/g, '\\"');
    const result = await this.execCommand(
      `node -e "const { Client } = require('pg'); const client = new Client({ connectionString: \\"${escaped}\\" }); client.connect().then(() => client.end()).then(() => process.exit(0)).catch(() => process.exit(1));"`,
      { allowFailure: true },
    );

    if (result.ok) {
      return true;
    }

    const fallback = await this.execCommand(
      `node -e "const { Client } = require('pg'); const url = new URL(\\"${escaped}\\"); const client = new Client({ host: url.hostname, port: Number(url.port || 5432), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: 'postgres' }); client.connect().then(() => client.end()).then(() => process.exit(0)).catch(() => process.exit(1));"`,
      { allowFailure: true },
    );

    return fallback.ok && Boolean(database);
  }

  private async detectDockerPostgres(env: Record<string, string>): Promise<boolean> {
    const dockerCheck = await this.execCommand('docker ps --format "{{.Names}}"', { allowFailure: true });
    if (!dockerCheck.ok) {
      return false;
    }

    const output = dockerCheck.stdout;
    if (/postgres/i.test(output)) {
      return true;
    }

    const composeCheck = await this.execCommand(
      `docker compose -f "${this.postgresComposeFile}" --env-file "${this.postgresEnvFile}" ps`,
      { allowFailure: true },
    );

    return composeCheck.ok && /postgres/i.test(composeCheck.stdout);
  }

  private async waitForDatabase(databaseUrl: string): Promise<void> {
    for (let i = 0; i < 30; i += 1) {
      if (await this.checkDatabaseUrl(databaseUrl)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new Error('PostgreSQL did not become ready in time');
  }

  private async ensureDatabaseExists(databaseUrl: string, databaseName: string): Promise<void> {
    const adminUrl = new URL(databaseUrl);
    adminUrl.pathname = '/postgres';

    const command =
      `node -e "const { Client } = require('pg'); ` +
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

  private async dropDatabase(databaseUrl: string, databaseName: string): Promise<void> {
    const adminUrl = new URL(databaseUrl);
    adminUrl.pathname = '/postgres';

    const command =
      `node -e "const { Client } = require('pg'); ` +
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

  private async updateProjectEnv(key: string, value: string): Promise<void> {
    const current = (await this.fileExists(this.defaultEnvPath))
      ? await this.readFile(this.defaultEnvPath)
      : '';
    const next = this.upsertEnvValue(current, key, value);
    await this.writeFile(this.defaultEnvPath, next);
  }
}