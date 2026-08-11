/**
 * Production installer for TAZAXY and 3X-UI integration.
 */
import { BaseCommand, type InstallOptions, type TazaxyPanelRuntimeConfig } from './install.interface';
import { execFile } from 'child_process';
import * as fs from 'fs';
export type { InstallOptions };

type XuiDetection = {
  state: string;
  detail?: string;
  recovery?: string;
  data?: {
    installation?: { kind?: string; service?: { workingDirectory?: string | null } };
    panel?: { url?: string | null; port?: number | null; webBasePath?: string; tls?: { enabled?: boolean } };
    subscription?: { scheme?: string; host?: string; port?: number | null; path?: string };
    authentication?: { username?: string | null };
  };
};

const { createXuiRuntimeDetector } = require('../installer/xui-runtime-detector') as {
  createXuiRuntimeDetector: () => {
    discover(options?: { publicHost?: string }): Promise<XuiDetection>;
    authenticate(
      detection: XuiDetection,
      credentials: { username: string; password: string },
    ): Promise<XuiDetection>;
  };
};
const { createPostgresDetector } = require('../installer/postgres-detector') as {
  createPostgresDetector: () => {
    discover(): Promise<{
      status: string;
      source: string;
      connection?: { host: string; port: number; database: string };
      containerName?: string;
      candidates?: Array<{
        source: string;
        containerName?: string;
        ready?: boolean | null;
        connection: { host: string; port: number; database: string };
      }>;
    }>;
  };
};
const {
  classifyDeployment,
  buildDatabaseUrl,
  DEFAULT_SUBNET,
  DEFAULT_GATEWAY,
} = require('../installer/db-route-resolver') as {
  classifyDeployment(detection: { source?: string; containerName?: string }): 'docker' | 'native-host' | 'unknown';
  buildDatabaseUrl(options: {
    user: string;
    password: string;
    host: string;
    port: number;
    database: string;
    schema: string;
    appInDocker: boolean;
  }): string;
  DEFAULT_SUBNET: string;
  DEFAULT_GATEWAY: string;
};
const { createPostgresProvisioner } = require('../installer/postgres-provisioner') as {
  createPostgresProvisioner(options: {
    runtime: {
      run(command: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }>;
      writeFile(filePath: string, content: string): Promise<void>;
    };
  }): {
    ensureRoleAndDatabase(options: { role: string; password: string; database: string }): Promise<unknown>;
    ensureNetworkAccess(options: {
      role: string;
      database: string;
      subnet: string;
      gateway: string;
      confPath: string;
      hbaPath: string;
    }): Promise<unknown>;
    ensureScopedFirewallRule(options: { subnet: string; gateway: string; bridge: string; port: number }): Promise<unknown>;
  };
};
const { createDbConnectivityVerifier } = require('../installer/db-connectivity-verifier') as {
  createDbConnectivityVerifier: () => {
    inspectNetwork(network: string): Promise<{ subnet: string | null; gateway: string | null; bridge: string | null; exists: boolean }>;
    verify(options: {
      detection: { source?: string; containerName?: string; host: string };
      network: string;
      user: string;
      password: string;
      database: string;
      port: number;
    }): Promise<{
      networkMissing: boolean;
      route: { host: string };
      probe: { reachable: boolean; authenticated: boolean } | null;
      state: { detail?: string; recovery?: string } | null;
    }>;
  };
};
const { createComposeLifecycle } = require('../installer/compose-lifecycle') as {
  createComposeLifecycle(): {
    reconcileStaleContainers(options: { composeFile: string; envFile: string }): Promise<{ removed: string[] }>;
  };
};

type DockerNetworkRoute = { name: string; subnet: string; gateway: string; bridge: string };

export class InstallCommand extends BaseCommand {
  private readonly xuiInstallUrl = 'https://raw.githubusercontent.com/mhsanaei/3x-ui/master/install.sh';

  async execute(options: InstallOptions): Promise<void> {
    this.setExecutionMode(options);
    this.section('TAZAXY Production Installer');

    const platform = await this.detectLinuxPlatform();
    await this.validatePlatform(platform);
    await this.ensureRootPrivileges();

    const publicIp = await this.detectPublicIp();
    const domain = options.domain || '';
    const apiPort = await this.findAvailablePort(3000, 3001);
    const httpPort = await this.findAvailablePort(80, 8080);
    const httpsPort = await this.findAvailablePort(443, 8443);

    await this.saveRuntimeConfig((config) => ({
      ...config,
      installedAt: config.installedAt || new Date().toISOString(),
      platform,
      app: {
        domain,
        publicIp,
        apiPort,
        webPort: httpPort,
        webSecurePort: httpsPort,
      },
    }));

    await this.ensureDockerInstalled(platform.family);
    await this.ensureDockerComposeInstalled(platform.family);
    await this.ensureBasePackages(platform.family);
    const databaseNetwork = await this.ensureDatabaseNetwork();
    await this.configureFirewall(httpPort, httpsPort, apiPort);

    const panelRuntime = await this.ensure3xuiRuntime(options, publicIp);
    await this.ensureEnvironmentWizard(options, publicIp, apiPort, panelRuntime, databaseNetwork);
    await this.buildAndStartContainers();
    await this.runPrismaTasks();
    await this.reconcileXuiRuntime(panelRuntime);
    await this.ensureSuperAdmin();
    await this.validateInstallation(panelRuntime);
    await this.showFinalSummary(panelRuntime);
  }

  private async validatePlatform(platform: { distro: string; family: string; architecture: string }): Promise<void> {
    this.log(`Detected platform: ${platform.distro} (${platform.architecture})`, 'info');

    if (platform.family === 'unknown') {
      throw new Error(`Unsupported Linux distribution: ${platform.distro}`);
    }

    if (!['x86_64', 'amd64', 'aarch64', 'arm64'].includes(platform.architecture)) {
      this.log(`Architecture ${platform.architecture} is not officially validated but installation will continue.`, 'warn');
    }
  }

  private async ensureRootPrivileges(): Promise<void> {
    if (!this.isRootUser()) {
      throw new Error('Installer must be executed with root privileges.');
    }
  }

  private async ensureDockerInstalled(family: string): Promise<void> {
    const existing = await this.execCommand('docker --version', { allowFailure: true });
    if (existing.ok) {
      this.log(existing.stdout.trim(), 'success');
      return;
    }

    this.section('Installing Docker');

    if (family === 'debian') {
      await this.execOrThrow('apt-get install -y ca-certificates curl gnupg lsb-release');

      await this.execCommand('rm -f /etc/apt/sources.list.d/docker.list', { allowFailure: true });
      await this.execCommand('rm -f /etc/apt/keyrings/docker.gpg', { allowFailure: true });
      await this.execOrThrow('install -m 0755 -d /etc/apt/keyrings');
      await this.execOrThrow('sh -c "curl -fsSL https://download.docker.com/linux/$(. /etc/os-release && echo $ID)/gpg | gpg --dearmor --batch --yes -o /etc/apt/keyrings/docker.gpg"');
      await this.execOrThrow('chmod a+r /etc/apt/keyrings/docker.gpg');
      await this.execOrThrow('sh -c ". /etc/os-release && echo \\"deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$ID $VERSION_CODENAME stable\\" | tee /etc/apt/sources.list.d/docker.list >/dev/null"');
      await this.execOrThrow('cat /etc/apt/sources.list.d/docker.list');
      await this.execOrThrow('apt-get update');
      await this.execOrThrow('apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin');
    } else {
      await this.execOrThrow('curl -fsSL https://get.docker.com | sh', { timeout: 300000 });
    }

    await this.execCommand('systemctl enable --now docker', { allowFailure: true });
    this.log('Docker installed.', 'success');
  }

  private async ensureDockerComposeInstalled(family: string): Promise<void> {
    const existing = await this.execCommand('docker compose version', { allowFailure: true });
    if (existing.ok) {
      this.log(existing.stdout.trim(), 'success');
      return;
    }

    if (family === 'debian') {
      await this.execOrThrow('apt-get install -y docker-compose-plugin');
    } else {
      await this.execOrThrow('mkdir -p /usr/local/lib/docker/cli-plugins');
      await this.execOrThrow('curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 -o /usr/local/lib/docker/cli-plugins/docker-compose');
      await this.execOrThrow('chmod +x /usr/local/lib/docker/cli-plugins/docker-compose');
    }

    this.log('Docker Compose plugin installed.', 'success');
  }

  private async ensureBasePackages(family: string): Promise<void> {
    this.section('Installing base packages');
    const packages =
      family === 'debian'
        ? 'curl jq unzip tar gzip ufw git ca-certificates'
        : 'curl jq unzip tar gzip firewalld git ca-certificates';

    if (family === 'debian') {
      await this.execOrThrow(`apt-get install -y ${packages}`);
    } else {
      await this.execOrThrow(`yum install -y ${packages}`, { timeout: 300000 });
    }
  }

  private async configureFirewall(httpPort: number, httpsPort: number, apiPort: number): Promise<void> {
    this.section('Configuring firewall');

    const ufw = await this.execCommand('which ufw', { allowFailure: true });
    if (ufw.ok) {
      await this.execCommand('ufw allow OpenSSH', { allowFailure: true });
      await this.execCommand(`ufw allow ${httpPort}/tcp`, { allowFailure: true });
      await this.execCommand(`ufw allow ${httpsPort}/tcp`, { allowFailure: true });
      await this.execCommand(`ufw allow ${apiPort}/tcp`, { allowFailure: true });
      await this.execCommand('ufw --force enable', { allowFailure: true });
      this.log('UFW rules configured.', 'success');
      return;
    }

    const firewalld = await this.execCommand('which firewall-cmd', { allowFailure: true });
    if (firewalld.ok) {
      await this.execCommand('systemctl enable --now firewalld', { allowFailure: true });
      await this.execCommand(`firewall-cmd --permanent --add-port=${httpPort}/tcp`, { allowFailure: true });
      await this.execCommand(`firewall-cmd --permanent --add-port=${httpsPort}/tcp`, { allowFailure: true });
      await this.execCommand(`firewall-cmd --permanent --add-port=${apiPort}/tcp`, { allowFailure: true });
      await this.execCommand('firewall-cmd --reload', { allowFailure: true });
      this.log('firewalld rules configured.', 'success');
      return;
    }

    this.log('No supported firewall tool detected; firewall step skipped.', 'warn');
  }

  private async ensure3xuiRuntime(options: InstallOptions, publicIp: string): Promise<TazaxyPanelRuntimeConfig> {
    this.section('Discovering 3X-UI runtime');
    const detector = createXuiRuntimeDetector();
    const publicHost = options.panelUrl ? new URL(this.normalizePanelUrl(options.panelUrl)).hostname : publicIp;
    let detection = await detector.discover({ publicHost });

    if (detection.state === 'NOT_FOUND' && !options.skip3xui) {
      await this.execOrThrow(`curl -fsSL ${this.xuiInstallUrl} -o /tmp/3x-ui-install.sh`);
      await this.execOrThrow('chmod +x /tmp/3x-ui-install.sh');
      await this.execOrThrow('bash /tmp/3x-ui-install.sh', { timeout: 300000 });
      this.log('3X-UI installed.', 'success');
      detection = await detector.discover({ publicHost });
    }

    if (detection.state === 'NOT_FOUND') throw new Error(`XUI_NOT_FOUND: ${detection.recovery || detection.detail || ''}`);
    if (detection.state === 'FAILED') throw new Error(`3X-UI discovery failed: ${detection.detail || detection.recovery || 'unknown error'}`);

    const discovered = detection.data;
    const panelUrl = discovered?.panel?.url;
    const subscriptionPort = discovered?.subscription?.port;
    if (!panelUrl || !subscriptionPort) {
      throw new Error('3X-UI discovery did not return authoritative panel and subscription endpoints');
    }

    const discoveredUser = options.panelUser || discovered.authentication?.username;
    if (!discoveredUser && this.autoApprove) throw new Error('AUTH_REQUIRED: 3X-UI admin username could not be discovered');
    const panelUser = discoveredUser || await this.promptRequired('3X-UI admin username');
    let panelPass = '';
    let authenticated: XuiDetection = detection;
    for (let attempt = 0; attempt < 3 && authenticated.state !== 'CONNECTED'; attempt += 1) {
      panelPass = await this.promptSecret('3X-UI admin password');
      if (!panelPass) break;
      authenticated = await detector.authenticate(detection, { username: panelUser, password: panelPass });
      if (authenticated.state === 'NEEDS_CREDENTIALS') this.log('3X-UI rejected the supplied credentials.', 'warn');
      else if (authenticated.state !== 'CONNECTED') break;
    }
    if (authenticated.state !== 'CONNECTED') {
      const prefix = authenticated.state === 'NEEDS_CREDENTIALS' || !panelPass ? 'AUTH_REQUIRED' : '3X-UI authentication failed';
      throw new Error(`${prefix}: ${authenticated.recovery || authenticated.detail || 'credentials could not be validated'}`);
    }

    const panel = authenticated.data?.panel || discovered.panel;
    const subscription = authenticated.data?.subscription || discovered.subscription;
    const subscriptionPath = this.normalizePathSegment(subscription?.path || '', 'sub');
    const subscriptionScheme = subscription?.scheme || (panel?.tls?.enabled ? 'https' : 'http');
    const subscriptionHost = subscription?.host || new URL(panelUrl).hostname;
    const runtimePreview: TazaxyPanelRuntimeConfig = {
      panelUrl,
      panelUser,
      panelPass,
      apiUrl: `${panelUrl.replace(/\/+$/, '')}/panel/api`,
      subscriptionBaseUrl: `${subscriptionScheme}://${subscriptionHost}:${subscriptionPort}`,
      subscriptionPath,
      subscriptionPort,
      tlsEnabled: Boolean(panel?.tls?.enabled),
      webRoot: panel?.webBasePath || new URL(panelUrl).pathname,
      installationDirectory: discovered.installation?.service?.workingDirectory || undefined,
      importedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.log(`Reusing discovered 3X-UI panel ${panelUrl}; subscription endpoint remains on ${subscriptionPort}${subscriptionPath}.`, 'success');

    await this.saveRuntimeConfig((config) => ({
      ...config,
      panel: {
        ...runtimePreview,
        panelPass: undefined,
      },
    }));
    return runtimePreview;
  }

  private async ensureDatabaseNetwork(): Promise<DockerNetworkRoute> {
    const name = 'tazaxy-network';
    const verifier = createDbConnectivityVerifier();
    let network = await verifier.inspectNetwork(name);
    if (!network.exists) {
      await this.execOrThrow(
        `docker network create --driver bridge --subnet ${DEFAULT_SUBNET} --gateway ${DEFAULT_GATEWAY} ${name}`,
      );
      network = await verifier.inspectNetwork(name);
    }
    if (!network.exists || !network.subnet || !network.gateway || !network.bridge) {
      throw new Error(`Unable to inspect subnet/gateway/bridge for Docker network ${name}`);
    }
    return { name, subnet: network.subnet, gateway: network.gateway, bridge: network.bridge };
  }

  private async ensureEnvironmentWizard(
    options: InstallOptions,
    publicIp: string,
    apiPort: number,
    panel: TazaxyPanelRuntimeConfig,
    databaseNetwork: DockerNetworkRoute,
  ): Promise<void> {
    this.section('Step 1/4 - Application and bot configuration');
    const appUrl = options.domain ? `https://${options.domain}` : `http://${publicIp}:${apiPort}`;
    const botToken = await this.promptForValidTelegramBotToken();
    const primarySuperAdminTelegramId = await this.promptForValidTelegramId();
    const superAdminEmail = (await this.prompt('Super admin email', 'admin@tazaxy.local')).trim() || 'admin@tazaxy.local';
    const superAdminPassword = await this.promptSecretWithMinLength('Super admin password', 8, this.generatePassword(16));
    const webhookSecret = this.generateSecret(40);

    this.section('Step 2/4 - Database configuration');
    const database = await this.resolveDatabaseConfiguration(databaseNetwork);

    this.section('Step 3/4 - Object storage configuration');
    const s3AccessKey = (await this.prompt('S3 access key', 'minioadmin')).trim() || 'minioadmin';
    const s3SecretKey = await this.promptSecret('S3 secret key', this.generatePassword(20));
    const s3PublicUrl = `http://${publicIp}:9000/tazaxy`;

    this.section('Step 4/4 - Writing environment and validating');
    const runtime = await this.loadRuntimeConfig();
    const envTemplate = await this.readFile('.env.example');
    let envContent = envTemplate;

    const jwtAccessSecret = this.generateSecret(48);
    const jwtRefreshSecret = this.generateSecret(48);
    const encryptionKey = this.generateSecret(32);
    envContent = this.upsertEnvValue(envContent, 'NODE_ENV', 'production');
    envContent = this.upsertEnvValue(envContent, 'APP_PORT', String(apiPort));
    envContent = this.upsertEnvValue(envContent, 'APP_URL', appUrl);
    envContent = this.upsertEnvValue(envContent, 'CORS_ORIGINS', appUrl);
    envContent = this.upsertEnvValue(envContent, 'DATABASE_URL', database.url);
    envContent = this.upsertEnvValue(envContent, 'POSTGRES_HOST', database.host);
    envContent = this.upsertEnvValue(envContent, 'POSTGRES_PORT', String(database.port));
    envContent = this.upsertEnvValue(envContent, 'POSTGRES_DB', database.name);
    envContent = this.upsertEnvValue(envContent, 'POSTGRES_USER', database.user);
    envContent = this.upsertEnvValue(envContent, 'POSTGRES_PASSWORD', database.password);
    envContent = this.upsertEnvValue(envContent, 'REDIS_HOST', 'redis');
    envContent = this.upsertEnvValue(envContent, 'REDIS_PORT', '6379');
    envContent = this.upsertEnvValue(envContent, 'TELEGRAM_BOT_TOKEN', botToken);
    envContent = this.upsertEnvValue(envContent, 'JWT_ACCESS_SECRET', jwtAccessSecret);
    envContent = this.upsertEnvValue(envContent, 'JWT_REFRESH_SECRET', jwtRefreshSecret);
    envContent = this.upsertEnvValue(envContent, 'WEBHOOK_SECRET', webhookSecret);
    envContent = this.upsertEnvValue(envContent, 'ENCRYPTION_KEY', encryptionKey);
    envContent = this.upsertEnvValue(envContent, 'S3_BUCKET', 'tazaxy');
    envContent = this.upsertEnvValue(envContent, 'S3_ACCESS_KEY', s3AccessKey);
    envContent = this.upsertEnvValue(envContent, 'S3_SECRET_KEY', s3SecretKey);
    envContent = this.upsertEnvValue(envContent, 'S3_PUBLIC_URL', s3PublicUrl);
    envContent = this.upsertEnvValue(envContent, 'SUPER_ADMIN_EMAIL', superAdminEmail);
    envContent = this.upsertEnvValue(envContent, 'SUPER_ADMIN_PASSWORD', superAdminPassword);
    if (primarySuperAdminTelegramId) {
      envContent = this.upsertEnvValue(envContent, 'SUPER_ADMIN_TELEGRAM_ID', primarySuperAdminTelegramId);
    }
     envContent = this.upsertEnvValue(envContent, 'XUI_PANEL_BASE_URL', panel.panelUrl);
     envContent = this.upsertEnvValue(envContent, 'XUI_PANEL_USERNAME', panel.panelUser);
     envContent = this.upsertEnvValue(envContent, 'XUI_PANEL_PASSWORD', '');
     envContent = this.upsertEnvValue(envContent, 'XUI_PANEL_SUB_PORT', String(panel.subscriptionPort));
     envContent = this.upsertEnvValue(envContent, 'XUI_PANEL_SUB_PATH', panel.subscriptionPath);
     envContent = this.upsertEnvValue(envContent, 'XUI_PANEL_TLS_ENABLED', String(panel.tlsEnabled));
    envContent = this.upsertEnvValue(envContent, 'ONLINE_GATEWAY_CALLBACK_URL', `${appUrl}/api/v1/payments/online/callback`);

    this.assertEnvHasValues(envContent, [
      'APP_URL',
      'DATABASE_URL',
      'JWT_ACCESS_SECRET',
      'JWT_REFRESH_SECRET',
      'S3_BUCKET',
      'S3_ACCESS_KEY',
      'S3_SECRET_KEY',
      'S3_PUBLIC_URL',
      'TELEGRAM_BOT_TOKEN',
      'XUI_PANEL_BASE_URL',
      'WEBHOOK_SECRET',
      'ENCRYPTION_KEY',
      'SUPER_ADMIN_EMAIL',
      'SUPER_ADMIN_PASSWORD',
    ]);

    await this.writeFile(this.defaultEnvPath, envContent);
    await this.writeFile(runtime.paths.envFile, envContent);

    await this.saveRuntimeConfig((config) => ({
      ...config,
      telegram: {
        ...(config.telegram || {}),
        botToken,
      },
      panel: config.panel
        ? {
            ...config.panel,
            panelUser: panel.panelUser,
            panelPass: undefined,
          }
        : config.panel,
      superAdmins: primarySuperAdminTelegramId
        ? [primarySuperAdminTelegramId, ...config.superAdmins.filter((item) => item !== primarySuperAdminTelegramId)]
        : config.superAdmins,
    }));

    this.log(`Environment file written to ${this.defaultEnvPath}.`, 'success');
  }

  private async resolveDatabaseConfiguration(network: DockerNetworkRoute): Promise<{
    url: string;
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
  }> {
    const detection = await createPostgresDetector().discover();
    if (detection.status === 'NOT_FOUND' || !detection.connection) {
      throw new Error('PostgreSQL was not detected. Install it with "tazaxy infrastructure --install", then retry.');
    }

    const existing = await this.readExistingDatabaseCredential();
    const name = existing?.database || 'tazaxy';
    const user = existing?.user || (await this.prompt('PostgreSQL username for TAZAXY', 'tazaxy')).trim() || 'tazaxy';
    const password = existing?.password || await this.promptSecret('PostgreSQL password for TAZAXY', this.generatePassword(20));
    const topology = detection.candidates?.find((candidate) =>
      candidate.ready &&
      /docker|compose|container|systemd|process|native|socket/.test(candidate.source) &&
      candidate.connection.host === detection.connection!.host &&
      candidate.connection.port === detection.connection!.port,
    ) || detection;
    const deployment = classifyDeployment(topology);
    if (deployment === 'native-host') {
      await this.provisionNativePostgres(
        { user, password, database: name, port: detection.connection.port },
        network,
      );
    }

    const verification = await createDbConnectivityVerifier().verify({
      detection: { ...topology, host: detection.connection.host },
      network: network.name,
      user,
      password,
      database: name,
      port: detection.connection.port,
    });
    if (verification.networkMissing || !verification.probe?.authenticated) {
      throw new Error(
        `PostgreSQL is not usable from ${network.name}; app startup aborted. ` +
          `${verification.state?.detail || verification.state?.recovery || 'TCP/authentication was not proven.'}`,
      );
    }

    return {
      url: buildDatabaseUrl({
        user,
        password,
        host: verification.route.host,
        port: detection.connection.port,
        database: name,
        schema: 'public',
        appInDocker: true,
      }),
      host: verification.route.host,
      port: detection.connection.port,
      name,
      user,
      password,
    };
  }

  private async readExistingDatabaseCredential(): Promise<{ user: string; password: string; database: string } | null> {
    if (!(await this.fileExists(this.defaultEnvPath))) return null;
    const value = /^(?:DATABASE_URL)=(.*)$/m.exec(await this.readFile(this.defaultEnvPath))?.[1]?.trim();
    if (!value) return null;
    try {
      const url = new URL(value);
      if (!/^postgres(?:ql)?:$/.test(url.protocol)) return null;
      const database = decodeURIComponent(url.pathname.replace(/^\//, '')) || '';
      if (database !== 'tazaxy') return null;
      return {
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database,
      };
    } catch {
      return null;
    }
  }

  private async provisionNativePostgres(
    input: { user: string; password: string; database: string; port: number },
    network: DockerNetworkRoute,
  ): Promise<void> {
    const run = (command: string, args: string[]) => new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) => {
      execFile(command, args, { windowsHide: true }, (error, stdout, stderr) => resolve({
        ok: !error,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
      }));
    });
    const runtime = { run, writeFile: (filePath: string, content: string) => fs.promises.writeFile(filePath, content, 'utf8') };
    const provisioner = createPostgresProvisioner({ runtime });
    const config = await run('sudo', ['-u', 'postgres', 'psql', '-tAc', 'SHOW config_file;']);
    const hba = await run('sudo', ['-u', 'postgres', 'psql', '-tAc', 'SHOW hba_file;']);
    if (!config.ok || !config.stdout || !hba.ok || !hba.stdout) throw new Error('Unable to locate native PostgreSQL configuration');
    await provisioner.ensureRoleAndDatabase({ role: input.user, password: input.password, database: input.database });
    await provisioner.ensureNetworkAccess({
      role: input.user,
      database: input.database,
      subnet: network.subnet,
      gateway: network.gateway,
      confPath: config.stdout.split(/\r?\n/).at(-1)!,
      hbaPath: hba.stdout.split(/\r?\n/).at(-1)!,
    });
    await provisioner.ensureScopedFirewallRule({
      subnet: network.subnet,
      gateway: network.gateway,
      bridge: network.bridge,
      port: input.port,
    });
  }

  private async buildAndStartContainers(): Promise<void> {
    this.section('Building and starting containers');
    this.log('Building Docker images. This can take several minutes on first install.', 'info');
    await this.execOrThrow(this.composeCommand('build --progress plain'), { timeout: 600000 });
    const cleanup = await this.reconcileStaleComposeContainers();
    if (cleanup.removed.length > 0) this.log(`Removed stale TAZAXY containers: ${cleanup.removed.join(', ')}`, 'warn');
    this.log('Starting containers.', 'info');
    await this.execOrThrow(this.composeCommand('up -d'), { timeout: 600000 });
    this.log('Containers started.', 'success');
  }

  private reconcileStaleComposeContainers(): Promise<{ removed: string[] }> {
    return createComposeLifecycle().reconcileStaleContainers({
      composeFile: `${this.workspaceRoot}/docker-compose.yml`,
      envFile: this.defaultEnvPath,
    });
  }

  private async runPrismaTasks(): Promise<void> {
    this.section('Running Prisma tasks');
    await this.execOrThrow(`npx prisma generate --schema "${this.workspaceRoot}/prisma/schema.prisma"`, { timeout: 180000 });
    await this.execOrThrow(this.composeCommand('exec -T app npx prisma migrate deploy'), {
      timeout: 180000,
    });
    this.log('Prisma client generated and migrations applied.', 'success');
  }

  private async reconcileXuiRuntime(panel: TazaxyPanelRuntimeConfig): Promise<void> {
    this.section('Reconciling authenticated 3X-UI runtime');
    if (!panel.panelPass) throw new Error('Validated 3X-UI credentials are unavailable for runtime reconciliation');
    const payload = JSON.stringify({
      baseUrl: panel.panelUrl,
      username: panel.panelUser,
      password: panel.panelPass,
      subPort: panel.subscriptionPort,
      subPath: panel.subscriptionPath,
    });
    const result = await this.execWithInput(
      this.composeCommand('exec -T app node dist/src/scripts/reconcile-xui.js'),
      payload,
      { timeout: 120000 },
    );
    if (!result.ok) throw new Error('3X-UI runtime reconciliation failed');
    this.log('Authenticated 3X-UI panel, server, and eligible inbound inventory reconciled.', 'success');
  }

  private async ensureSuperAdmin(): Promise<void> {
    this.section('Configuring initial super admin');
    const envContent = await this.readFile(this.defaultEnvPath);
    const existingTelegramId = /^(?:SUPER_ADMIN_TELEGRAM_ID)=(.*)$/m.exec(envContent)?.[1]?.trim();

    if (existingTelegramId) {
      if (!/^\d+$/.test(existingTelegramId)) {
        throw new Error('Configured SUPER_ADMIN_TELEGRAM_ID must contain digits only');
      }
      this.log(`Primary super admin already configured: ${existingTelegramId}`, 'success');
      return;
    }

    const telegramId = await this.prompt('Primary super admin Telegram ID', '');
    if (!telegramId) {
      this.log('No super admin Telegram ID provided; this step was skipped.', 'warn');
      return;
    }

    const updatedEnvContent = this.upsertEnvValue(envContent, 'SUPER_ADMIN_TELEGRAM_ID', telegramId);
    await this.writeFile(this.defaultEnvPath, updatedEnvContent);

    const runtime = await this.loadRuntimeConfig();
    const runtimeEnvContent = await this.readFile(runtime.paths.envFile);
    await this.writeFile(runtime.paths.envFile, this.upsertEnvValue(runtimeEnvContent, 'SUPER_ADMIN_TELEGRAM_ID', telegramId));

    await this.saveRuntimeConfig((config) => ({
      ...config,
      superAdmins: [telegramId, ...config.superAdmins.filter((item) => item !== telegramId)],
    }));

    this.log(`Primary super admin configured: ${telegramId}`, 'success');
  }

  private async validateInstallation(panel: TazaxyPanelRuntimeConfig): Promise<void> {
    this.section('Validating installation');
    const services = await this.execCommand(this.composeCommand('ps --format json'), { allowFailure: true });
    const rows = services.stdout.trim().split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return [];
      }
    });
    for (const service of ['app', 'redis', 'minio', 'nginx']) {
      const row = rows.find((item) => item.Service === service);
      if (!services.ok || !row || row.State !== 'running' || row.Health !== 'healthy') {
        throw new Error(`Final validation failed: ${service} is not running and healthy`);
      }
    }

    const health = await this.execCommand(this.composeCommand('exec -T app wget -qO- http://127.0.0.1:3000/health'), { allowFailure: true });
    if (!health.ok || !/"status"\s*:\s*"ok"/i.test(health.stdout)) {
      throw new Error('Final validation failed: /health did not return a healthy response');
    }

    const ready = await this.execCommand(this.composeCommand('exec -T app wget -qO- http://127.0.0.1:3000/health/ready'), { allowFailure: true });
    if (!ready.ok || !/"database"\s*:\s*\{[^}]*"status"\s*:\s*"up"/i.test(ready.stdout)) {
      throw new Error('Final validation failed: /health/ready did not prove database readiness');
    }

    const migrations = await this.execCommand(this.composeCommand('exec -T app npx prisma migrate status'), { allowFailure: true });
    if (!migrations.ok || !/Database schema is up to date!/i.test(`${migrations.stdout}\n${migrations.stderr}`)) {
      throw new Error('Final validation failed: production migrations are not up to date');
    }

    const diagnosis = await this.execWithInput(
      this.composeCommand('exec -T app node dist/src/scripts/diagnose-xui.js'),
      JSON.stringify({
        baseUrl: panel.panelUrl,
        subPort: panel.subscriptionPort,
        subPath: panel.subscriptionPath,
        source: 'installer-authenticated',
        observedAt: new Date().toISOString(),
        listenerCoherent: true,
      }),
      { timeout: 120000 },
    );
    let diagnostic: any;
    try {
      diagnostic = JSON.parse(diagnosis.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || '');
    } catch {
      diagnostic = null;
    }
    if (!diagnosis.ok || diagnostic?.state !== 'CONNECTED' || diagnostic?.applicationConnectivity !== true || diagnostic?.apiProbe !== true) {
      throw new Error('Final validation failed: authenticated 3X-UI application-context diagnosis is not CONNECTED');
    }
    this.log(`Resolved subscription endpoint: ${this.buildSubscriptionUrl(panel, '<subscription_id>')}`, 'info');
    this.log('All required application, database, storage, proxy, migration, and 3X-UI checks passed.', 'success');
  }

  private async showFinalSummary(panel: TazaxyPanelRuntimeConfig): Promise<void> {
    const runtime = await this.loadRuntimeConfig();
    console.log('\nInstallation summary');
    console.log('--------------------');
    console.log(`Public IP: ${runtime.app?.publicIp || 'unknown'}`);
    console.log(`Domain: ${runtime.app?.domain || '(not configured)'}`);
    console.log(`API Port: ${runtime.app?.apiPort || 'unknown'}`);
    console.log(`Subscription Endpoint: ${this.buildSubscriptionUrl(panel, '<subscription_id>')}`);
    console.log(`Environment File: ${this.defaultEnvPath}`);
    console.log(`Super Admins: ${runtime.superAdmins.length > 0 ? runtime.superAdmins.join(', ') : '(none)'}`);
    console.log(`Runtime config: ${runtime.paths.stateFile}`);
    console.log(`Installer log: ${runtime.paths.installLogFile}`);
    this.log('Installation flow completed. Re-open the CLI to use the main menu.', 'success');
  }

  private async promptForValidTelegramBotToken(): Promise<string> {
    while (true) {
      const token = await this.promptRequired('Telegram bot token');
      const result = await this.execCommand(`curl -fsS "https://api.telegram.org/bot${token}/getMe"`, {
        allowFailure: true,
        timeout: 20000,
      });
      const payload = `${result.stdout || ''}${result.stderr || ''}`.trim();

      if (result.ok && /"ok"\s*:\s*true/.test(payload)) {
        this.log('Telegram bot token validated.', 'success');
        return token;
      }

      this.log('Telegram bot token is invalid or unreachable. Please enter a valid token.', 'warn');
    }
  }

  private async promptForValidTelegramId(): Promise<string> {
    while (true) {
      const telegramId = await this.promptRequired('Primary super admin Telegram ID');
      if (/^\d+$/.test(telegramId)) return telegramId;
      this.log('Primary super admin Telegram ID must contain digits only.', 'warn');
    }
  }

  private async promptSecretWithMinLength(question: string, minimum: number, defaultValue = ''): Promise<string> {
    while (true) {
      const value = await this.promptSecret(question, defaultValue);
      if (value.length >= minimum) return value;
      this.log(`${question} must contain at least ${minimum} characters.`, 'warn');
    }
  }

  private assertEnvHasValues(content: string, keys: string[]): void {
    const missing = keys.filter((key) => {
      const match = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
      return !match || !match[1].trim();
    });

    if (missing.length > 0) {
      throw new Error(`Generated .env is missing required values: ${missing.join(', ')}`);
    }
  }

  private generatePassword(length: number): string {
    return this.generateSecret(length).slice(0, Math.max(12, length));
  }
}
