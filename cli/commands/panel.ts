/**
 * Panel Command - Manage 3X-UI panel connections and runtime discovery.
 */
import { BaseCommand, type TazaxyPanelRuntimeConfig } from './install.interface';
import { URL } from 'url';

const { createXuiCredentialValidator } = require('../../installer/xui-credential-validator') as {
  createXuiCredentialValidator: () => {
    validate(input: { connection: { url: string }; username: string; password: string }): Promise<{ status: string }>;
  };
};

export interface PanelOptions {
  add?: boolean;
  remove?: boolean;
  list?: boolean;
  test?: boolean;
  sync?: boolean;
  url?: string;
  user?: string;
  subPort?: number;
  subPath?: string;
  discover?: boolean;
}

export class PanelCommand extends BaseCommand {
  async execute(options: PanelOptions): Promise<void> {
    this.section('3X-UI Panel Settings');

    if (options.list) {
      await this.listPanels();
      return;
    }

    if (options.remove) {
      await this.removePanel();
      return;
    }

    if (options.test) {
      await this.testPanel(options);
      return;
    }

    if (options.sync) {
      await this.syncPanel();
      return;
    }

    if (options.discover) {
      await this.discoverCurrentPanel(options);
      return;
    }

    if (options.add) {
      await this.addPanel(options);
      return;
    }

    await this.showMenu();
  }

  private async listPanels(): Promise<void> {
    const config = await this.loadRuntimeConfig();

    if (!config.panel) {
      this.log('No 3X-UI panel is configured.', 'warn');
      return;
    }

    const panel = config.panel;
    console.log(`  Panel URL: ${panel.panelUrl}`);
    console.log(`  API URL: ${panel.apiUrl}`);
    console.log(`  Subscription Base URL: ${panel.subscriptionBaseUrl}`);
    console.log(`  Subscription Path: /${panel.subscriptionPath}`);
    console.log(`  Subscription Port: ${panel.subscriptionPort}`);
    console.log(`  TLS Enabled: ${panel.tlsEnabled ? 'yes' : 'no'}`);
    console.log(`  Installation Directory: ${panel.installationDirectory || 'unknown'}`);
    console.log(`  Reverse Proxy: ${panel.reverseProxy || 'none'}`);
    console.log(`  Updated At: ${panel.updatedAt}`);
  }

  private async addPanel(options: PanelOptions): Promise<void> {
    const tlsEnabled = options.url
      ? new URL(this.normalizePanelUrl(options.url)).protocol === 'https:'
      : (await this.confirm('TLS Enabled?', true));
    const panelUrl = this.normalizePanelUrl(
      options.url || (await this.prompt('Panel URL', 'https://domain:2053/basePath/')),
      tlsEnabled,
      2053,
    );
    const panelUser = options.user || (await this.prompt('Panel username', 'admin'));
    const panelPass = await this.promptSecret('Panel password');
    const runtimePreview = this.buildPanelRuntimePreview({
      panelUrl,
      tlsEnabled,
      panelUser,
      panelPass,
      subscriptionPort: options.subPort || Number.parseInt(await this.prompt('Subscription port', '2053'), 10) || 2053,
      subscriptionPath: options.subPath || (await this.prompt('Subscription path', 'sub')),
    });

    const discovered = await this.discoverPanelRuntime({
      panelUrl: runtimePreview.panelUrl,
      panelUser,
      panelPass,
      requestedSubPort: runtimePreview.subscriptionPort,
      requestedSubPath: runtimePreview.subscriptionPath,
    });

    await this.saveRuntimeConfig((config) => ({
      ...config,
      panel: discovered,
    }));

    this.log('Panel runtime configuration saved.', 'success');
    this.log(`Subscription endpoint: ${this.buildSubscriptionUrl(discovered, '<subscription_id>')}`, 'info');
  }

  private async removePanel(): Promise<void> {
    await this.saveRuntimeConfig((config) => ({
      ...config,
      panel: undefined,
    }));

    const config = await this.loadRuntimeConfig();
    if (await this.fileExists(config.paths.envFile)) {
      let envContent = await this.readFile(config.paths.envFile);
      envContent = this.upsertEnvValue(envContent, 'VPN_PANEL_URL', '');
      envContent = this.upsertEnvValue(envContent, 'VPN_PANEL_USERNAME', '');
      envContent = this.upsertEnvValue(envContent, 'VPN_PANEL_PASSWORD', '');
      envContent = this.upsertEnvValue(envContent, 'VPN_PANEL_API_URL', '');
      envContent = this.upsertEnvValue(envContent, 'VPN_PANEL_SUBSCRIPTION_BASE_URL', '');
      envContent = this.upsertEnvValue(envContent, 'VPN_PANEL_SUBSCRIPTION_PATH', '');
      envContent = this.upsertEnvValue(envContent, 'VPN_PANEL_SUBSCRIPTION_PORT', '');
      await this.writeFile(config.paths.envFile, envContent);
    }

    this.log('Panel configuration removed from runtime state.', 'success');
  }

  private async testPanel(options: PanelOptions): Promise<void> {
    const config = await this.loadRuntimeConfig();
    const existing = config.panel;

    if (!existing && !options.url) {
      this.log('No panel configuration found. Add or discover a panel first.', 'error');
      return;
    }

    const runtime = await this.discoverPanelRuntime({
      panelUrl: this.normalizePanelUrl(options.url || existing!.panelUrl),
      panelUser: options.user || existing!.panelUser,
      panelPass: existing?.panelPass || await this.promptSecret('Panel password'),
      requestedSubPort: options.subPort || existing?.subscriptionPort,
      requestedSubPath: options.subPath || existing?.subscriptionPath,
    });

    this.log('Panel authentication succeeded.', 'success');
    this.log(`Resolved subscription endpoint: ${this.buildSubscriptionUrl(runtime, '<subscription_id>')}`, 'info');
  }

  private async syncPanel(): Promise<void> {
    const config = await this.loadRuntimeConfig();
    if (!config.panel) {
      this.log('No panel configuration found.', 'error');
      return;
    }

    this.log('Incremental synchronization hook prepared. Use installer or backend sync worker to import users safely.', 'info');
    this.log(`Current runtime endpoint: ${this.buildSubscriptionUrl(config.panel, '<subscription_id>')}`, 'info');
  }

  private async discoverCurrentPanel(options: PanelOptions): Promise<void> {
    const tlsEnabled = options.url
      ? new URL(this.normalizePanelUrl(options.url)).protocol === 'https:'
      : (await this.confirm('TLS Enabled?', true));
    const runtime = await this.discoverPanelRuntime({
      panelUrl: this.normalizePanelUrl(options.url || 'https://127.0.0.1:2053/', tlsEnabled, 2053),
      panelUser: options.user || 'admin',
      panelPass: await this.promptSecret('Panel password'),
      requestedSubPort: options.subPort,
      requestedSubPath: options.subPath,
    });

    await this.saveRuntimeConfig((config) => ({
      ...config,
      panel: runtime,
    }));

    this.log('3X-UI runtime configuration discovered and saved.', 'success');
  }

  private async showMenu(): Promise<void> {
    const action = await this.select('Choose a panel action', [
      { value: 'list', label: 'List panel runtime configuration' },
      { value: 'add', label: 'Add or update panel connection' },
      { value: 'discover', label: 'Discover panel runtime automatically' },
      { value: 'test', label: 'Test panel connectivity' },
      { value: 'sync', label: 'Show synchronization status' },
      { value: 'remove', label: 'Remove panel configuration' },
      { value: 'exit', label: 'Exit' },
    ]);

    if (action === 'exit') {
      this.log('No changes applied.', 'info');
      return;
    }

    if (action === 'list') {
      await this.listPanels();
      return;
    }

    if (action === 'remove') {
      await this.removePanel();
      return;
    }

    if (action === 'sync') {
      await this.syncPanel();
      return;
    }

    if (action === 'discover') {
      await this.discoverCurrentPanel({});
      return;
    }

    if (action === 'test') {
      await this.testPanel({});
      return;
    }

    await this.addPanel({});
  }

  private async discoverPanelRuntime(input: {
    panelUrl: string;
    panelUser: string;
    panelPass: string;
    requestedSubPort?: number;
    requestedSubPath?: string;
  }): Promise<TazaxyPanelRuntimeConfig> {
    const normalizedPanelUrl = this.normalizePanelUrl(input.panelUrl);
    const validation = await createXuiCredentialValidator().validate({
      connection: { url: normalizedPanelUrl },
      username: input.panelUser,
      password: input.panelPass,
    });
    if (validation.status !== 'FOUND') throw new Error('Unable to authenticate to 3X-UI');

    const panelUrlObject = new URL(normalizedPanelUrl);
    const tlsEnabled = panelUrlObject.protocol === 'https:';
    const subscriptionPort = input.requestedSubPort || Number(panelUrlObject.port || (tlsEnabled ? 443 : 80));
    const discoveredSubscriptionPath = input.requestedSubPath ?? 'sub';
    const subscriptionPath = this.normalizePathSegment(discoveredSubscriptionPath, 'sub');
    const subscriptionBaseUrl = `${panelUrlObject.protocol}//${panelUrlObject.hostname}:${subscriptionPort}`;

    return {
      panelUrl: normalizedPanelUrl,
      panelUser: input.panelUser,
      panelPass: undefined,
      apiUrl: `${normalizedPanelUrl}/panel/api`,
      subscriptionBaseUrl,
      subscriptionPath,
      subscriptionPort,
      tlsEnabled,
      updatedAt: new Date().toISOString(),
      installationDirectory: await this.detectInstallationDirectory(),
      reverseProxy: await this.detectReverseProxy(),
      webRoot: panelUrlObject.pathname || '/',
      metadata: {
        credentialsValidated: true,
      },
    };
  }

  private async detectInstallationDirectory(): Promise<string | undefined> {
    const candidates = ['/etc/x-ui', '/usr/local/x-ui', '/opt/3x-ui'];
    for (const candidate of candidates) {
      if (await this.fileExists(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  private async detectReverseProxy(): Promise<string | undefined> {
    const nginx = await this.execCommand('systemctl is-active nginx', { allowFailure: true });
    if (nginx.stdout.trim() === 'active') {
      return 'nginx';
    }

    const caddy = await this.execCommand('systemctl is-active caddy', { allowFailure: true });
    if (caddy.stdout.trim() === 'active') {
      return 'caddy';
    }

    return undefined;
  }

}
