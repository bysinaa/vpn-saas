/**
 * Production installer for VPN SaaS and 3X-UI integration.
 */
import { BaseCommand, type InstallOptions, type VpnSaasPanelRuntimeConfig } from './install.interface';
export type { InstallOptions };

export class InstallCommand extends BaseCommand {
  private readonly xuiInstallUrl = 'https://raw.githubusercontent.com/mhsanaei/3x-ui/master/install.sh';

  async execute(options: InstallOptions): Promise<void> {
    this.setExecutionMode(options);
    this.section('VPN SaaS Production Installer');

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
    await this.configureFirewall(httpPort, httpsPort, apiPort);

    const panelRuntime = await this.ensure3xuiRuntime(options, publicIp);
    await this.ensureEnvironmentWizard(options, publicIp, apiPort, panelRuntime);
    await this.buildAndStartContainers();
    await this.runPrismaTasks();
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
      await this.execOrThrow('apt-get update');
      await this.execOrThrow('apt-get install -y ca-certificates curl gnupg lsb-release');
      await this.execOrThrow('install -m 0755 -d /etc/apt/keyrings');
      await this.execOrThrow('sh -c "curl -fsSL https://download.docker.com/linux/$(. /etc/os-release && echo $ID)/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg"');
      await this.execOrThrow('chmod a+r /etc/apt/keyrings/docker.gpg');
      await this.execOrThrow('sh -c ". /etc/os-release && echo \\"deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$ID $VERSION_CODENAME stable\\" > /etc/apt/sources.list.d/docker.list"');
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

  private async ensure3xuiRuntime(options: InstallOptions, publicIp: string): Promise<VpnSaasPanelRuntimeConfig> {
    this.section('Preparing 3X-UI runtime');

    const installed = await this.execCommand('which x-ui || test -x /usr/local/x-ui/x-ui', { allowFailure: true });
    if (!installed.ok && !options.skip3xui) {
      await this.execOrThrow(`curl -fsSL ${this.xuiInstallUrl} -o /tmp/3x-ui-install.sh`);
      await this.execOrThrow('chmod +x /tmp/3x-ui-install.sh');
      await this.execOrThrow('bash /tmp/3x-ui-install.sh', { timeout: 300000 });
      this.log('3X-UI installed.', 'success');
    }

    const panelPort = await this.findAvailablePort(2053, 2054);
    const subscriptionPort = await this.findAvailablePort(2096, 2097);
    const subscriptionPath = this.normalizePathSegment('sub', 'sub');
    const tlsEnabled = false;
    const panelUrl = options.panelUrl || `http://${publicIp}:${panelPort}`;
    const panelUser = options.panelUser || (await this.prompt('3X-UI admin username', 'admin'));
    const panelPass = options.panelPass || (await this.prompt('3X-UI admin password', this.generatePassword(16)));

    await this.saveRuntimeConfig((config) => ({
      ...config,
      panel: {
        panelUrl,
        panelUser,
        panelPass,
        apiUrl: `${panelUrl}/panel/api`,
        subscriptionBaseUrl: `http://${publicIp}:${subscriptionPort}`,
        subscriptionPath,
        subscriptionPort,
        tlsEnabled,
        installationDirectory: '/usr/local/x-ui',
        updatedAt: new Date().toISOString(),
      },
    }));

    const runtime = await this.loadRuntimeConfig();
    return runtime.panel!;
  }

  private async ensureEnvironmentWizard(
    options: InstallOptions,
    publicIp: string,
    apiPort: number,
    panel: VpnSaasPanelRuntimeConfig,
  ): Promise<void> {
    this.section('Step 1/4 - Application and bot configuration');
    const appUrl = options.domain ? `https://${options.domain}` : `http://${publicIp}:${apiPort}`;
    const botToken = await this.prompt('Telegram bot token', '');
    const superAdminEmail = (await this.prompt('Super admin email', 'admin@vpn-saas.local')).trim() || 'admin@vpn-saas.local';
    const superAdminPassword = await this.promptSecret('Super admin password');
    const webhookSecret = this.generateSecret(40);

    this.section('Step 2/4 - Database configuration');
    const postgresDb = (await this.prompt('PostgreSQL database name', 'vpn_saas')).trim() || 'vpn_saas';
    const postgresUser = (await this.prompt('PostgreSQL username', 'postgres')).trim() || 'postgres';
    const postgresPassword = await this.promptSecret('PostgreSQL password');

    this.section('Step 3/4 - Object storage configuration');
    const s3AccessKey = (await this.prompt('S3 access key', 'minioadmin')).trim() || 'minioadmin';
    const s3SecretKey = await this.promptSecret('S3 secret key');
    const s3PublicUrl = `http://${publicIp}:9000/vpn-saas`;

    this.section('Step 4/4 - Writing environment and validating');
    const runtime = await this.loadRuntimeConfig();
    const envTemplate = await this.readFile('.env.example');
    let envContent = envTemplate;

    const jwtAccessSecret = this.generateSecret(48);
    const jwtRefreshSecret = this.generateSecret(48);
    const encryptionKey = this.generateSecret(32);
    const databaseUrl = `postgresql://${encodeURIComponent(postgresUser)}:${encodeURIComponent(postgresPassword)}@postgres:5432/${postgresDb}?schema=public`;

    envContent = this.upsertEnvValue(envContent, 'NODE_ENV', 'production');
    envContent = this.upsertEnvValue(envContent, 'APP_PORT', String(apiPort));
    envContent = this.upsertEnvValue(envContent, 'APP_URL', appUrl);
    envContent = this.upsertEnvValue(envContent, 'CORS_ORIGINS', appUrl);
    envContent = this.upsertEnvValue(envContent, 'DATABASE_URL', databaseUrl);
    envContent = this.upsertEnvValue(envContent, 'POSTGRES_DB', postgresDb);
    envContent = this.upsertEnvValue(envContent, 'POSTGRES_USER', postgresUser);
    envContent = this.upsertEnvValue(envContent, 'POSTGRES_PASSWORD', postgresPassword);
    envContent = this.upsertEnvValue(envContent, 'REDIS_HOST', 'redis');
    envContent = this.upsertEnvValue(envContent, 'REDIS_PORT', '6379');
    envContent = this.upsertEnvValue(envContent, 'TELEGRAM_BOT_TOKEN', botToken);
    envContent = this.upsertEnvValue(envContent, 'JWT_ACCESS_SECRET', jwtAccessSecret);
    envContent = this.upsertEnvValue(envContent, 'JWT_REFRESH_SECRET', jwtRefreshSecret);
    envContent = this.upsertEnvValue(envContent, 'WEBHOOK_SECRET', webhookSecret);
    envContent = this.upsertEnvValue(envContent, 'ENCRYPTION_KEY', encryptionKey);
    envContent = this.upsertEnvValue(envContent, 'S3_BUCKET', 'vpn-saas');
    envContent = this.upsertEnvValue(envContent, 'S3_ACCESS_KEY', s3AccessKey);
    envContent = this.upsertEnvValue(envContent, 'S3_SECRET_KEY', s3SecretKey);
    envContent = this.upsertEnvValue(envContent, 'S3_PUBLIC_URL', s3PublicUrl);
    envContent = this.upsertEnvValue(envContent, 'SUPER_ADMIN_EMAIL', superAdminEmail);
    envContent = this.upsertEnvValue(envContent, 'SUPER_ADMIN_PASSWORD', superAdminPassword);
    envContent = this.upsertEnvValue(envContent, 'SANITY_PANEL_BASE_URL', panel.panelUrl);
    envContent = this.upsertEnvValue(envContent, 'SANITY_PANEL_USERNAME', panel.panelUser);
    envContent = this.upsertEnvValue(envContent, 'SANITY_PANEL_PASSWORD', panel.panelPass);
    envContent = this.upsertEnvValue(envContent, 'SANITY_PANEL_SUB_PORT', String(panel.subscriptionPort));
    envContent = this.upsertEnvValue(envContent, 'SANITY_PANEL_SUB_PATH', panel.subscriptionPath);
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
      'SANITY_PANEL_BASE_URL',
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
            panelPass: panel.panelPass,
          }
        : config.panel,
    }));

    this.log(`Environment file written to ${this.defaultEnvPath}.`, 'success');
  }

  private async buildAndStartContainers(): Promise<void> {
    this.section('Building and starting containers');
    await this.execOrThrow(`docker compose --env-file "${this.defaultEnvPath}" build`, { timeout: 600000 });
    await this.execOrThrow(`docker compose --env-file "${this.defaultEnvPath}" up -d`, { timeout: 600000 });
    this.log('Containers started.', 'success');
  }

  private async runPrismaTasks(): Promise<void> {
    this.section('Running Prisma tasks');
    await this.execOrThrow(`npx prisma generate --schema "${this.workspaceRoot}/prisma/schema.prisma"`, { timeout: 180000 });
    await this.execOrThrow(`docker compose --env-file "${this.defaultEnvPath}" exec -T app npx prisma migrate deploy`, {
      timeout: 180000,
    });
    this.log('Prisma client generated and migrations applied.', 'success');
  }

  private async ensureSuperAdmin(): Promise<void> {
    this.section('Configuring initial super admin');
    const telegramId = await this.prompt('Primary super admin Telegram ID', '');
    if (!telegramId) {
      this.log('No super admin Telegram ID provided; this step was skipped.', 'warn');
      return;
    }

    const envContent = await this.readFile(this.defaultEnvPath);
    await this.writeFile(this.defaultEnvPath, this.upsertEnvValue(envContent, 'SUPER_ADMIN_TELEGRAM_ID', telegramId));

    const runtime = await this.loadRuntimeConfig();
    const runtimeEnvContent = await this.readFile(runtime.paths.envFile);
    await this.writeFile(runtime.paths.envFile, this.upsertEnvValue(runtimeEnvContent, 'SUPER_ADMIN_TELEGRAM_ID', telegramId));

    await this.saveRuntimeConfig((config) => ({
      ...config,
      superAdmins: [telegramId, ...config.superAdmins.filter((item) => item !== telegramId)],
    }));

    this.log(`Primary super admin configured: ${telegramId}`, 'success');
  }

  private async validateInstallation(panel: VpnSaasPanelRuntimeConfig): Promise<void> {
    this.section('Validating installation');
    await this.execCommand(`docker compose --env-file "${this.defaultEnvPath}" ps`, { allowFailure: true });
    await this.execCommand(
      `docker compose --env-file "${this.defaultEnvPath}" exec -T app node -e "console.log('runtime-subscription-endpoint:', process.env.SANITY_PANEL_BASE_URL || '')"`,
      { allowFailure: true },
    );
    this.log(`Resolved subscription endpoint: ${this.buildSubscriptionUrl(panel, '<subscription_id>')}`, 'info');
  }

  private async showFinalSummary(panel: VpnSaasPanelRuntimeConfig): Promise<void> {
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
