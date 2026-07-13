/**
 * Panel Command - Manage 3X-UI panel connections and runtime discovery.
 */
import { BaseCommand, type VpnSaasPanelRuntimeConfig } from './install.interface';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

export interface PanelOptions {
  add?: boolean;
  remove?: boolean;
  list?: boolean;
  test?: boolean;
  sync?: boolean;
  url?: string;
  user?: string;
  pass?: string;
  subPort?: number;
  subPath?: string;
  discover?: boolean;
}

interface HttpResponse {
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
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
    const panelUrl = options.url || (await this.prompt('Panel URL', 'http://127.0.0.1:2053'));
    const panelUser = options.user || (await this.prompt('Panel username', 'admin'));
    const panelPass = options.pass || (await this.promptSecret('Panel password'));
    const subPort = options.subPort || Number.parseInt(await this.prompt('Subscription port', '2053'), 10) || 2053;
    const subPath = this.normalizePathSegment(options.subPath || (await this.prompt('Subscription path', 'sub')), 'sub');

    const discovered = await this.discoverPanelRuntime({
      panelUrl,
      panelUser,
      panelPass,
      requestedSubPort: subPort,
      requestedSubPath: subPath,
    });

    await this.saveRuntimeConfig((config) => ({
      ...config,
      panel: discovered,
    }));

    await this.persistPanelEnv(discovered);

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
      panelUrl: options.url || existing!.panelUrl,
      panelUser: options.user || existing!.panelUser,
      panelPass: options.pass || existing!.panelPass,
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
    const runtime = await this.discoverPanelRuntime({
      panelUrl: options.url || 'http://127.0.0.1:2053',
      panelUser: options.user || 'admin',
      panelPass: options.pass || '',
      requestedSubPort: options.subPort,
      requestedSubPath: options.subPath,
    });

    await this.saveRuntimeConfig((config) => ({
      ...config,
      panel: runtime,
    }));

    await this.persistPanelEnv(runtime);

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
  }): Promise<VpnSaasPanelRuntimeConfig> {
    const normalizedPanelUrl = input.panelUrl.replace(/\/+$/, '');
    const loginResponse = await this.login(normalizedPanelUrl, input.panelUser, input.panelPass);
    if (loginResponse.statusCode >= 400) {
      throw new Error(`Unable to authenticate to 3X-UI (${loginResponse.statusCode})`);
    }

    const panelUrlObject = new URL(normalizedPanelUrl);
    const tlsEnabled = panelUrlObject.protocol === 'https:';
    const subscriptionPort = input.requestedSubPort || Number(panelUrlObject.port || (tlsEnabled ? 443 : 80));
    const discoveredSubscriptionPath = input.requestedSubPath ?? this.extractSubscriptionPath(loginResponse.body) ?? 'sub';
    const subscriptionPath = this.normalizePathSegment(discoveredSubscriptionPath, 'sub');
    const subscriptionBaseUrl = `${panelUrlObject.protocol}//${panelUrlObject.hostname}:${subscriptionPort}`;

    return {
      panelUrl: normalizedPanelUrl,
      panelUser: input.panelUser,
      panelPass: input.panelPass,
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
        loginStatusCode: loginResponse.statusCode,
      },
    };
  }

  private extractSubscriptionPath(payload: string): string | undefined {
    const patterns = [
      /subPath["']?\s*[:=]\s*["']([^"'\\/\s]+)["']/i,
      /subscription[_-]?path["']?\s*[:=]\s*["']([^"'\\/\s]+)["']/i,
      /\/([a-zA-Z0-9_-]{2,32})\/\$\{?sub/i,
    ];

    for (const pattern of patterns) {
      const match = payload.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }

    return undefined;
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

  private async login(panelUrl: string, username: string, password: string): Promise<HttpResponse> {
    const body = JSON.stringify({ username, password });
    return this.httpRequest({
      url: `${panelUrl}/login`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body).toString(),
      },
      body,
    });
  }

  private async persistPanelEnv(config: VpnSaasPanelRuntimeConfig): Promise<void> {
    const runtime = await this.loadRuntimeConfig();
    const envPath = runtime.paths.envFile;
    const existing = (await this.fileExists(envPath)) ? await this.readFile(envPath) : '';

    let updated = existing || '# VPN SaaS environment\n';
    updated = this.upsertEnvValue(updated, 'VPN_PANEL_URL', config.panelUrl);
    updated = this.upsertEnvValue(updated, 'VPN_PANEL_USERNAME', config.panelUser);
    updated = this.upsertEnvValue(updated, 'VPN_PANEL_PASSWORD', config.panelPass);
    updated = this.upsertEnvValue(updated, 'VPN_PANEL_API_URL', config.apiUrl);
    updated = this.upsertEnvValue(updated, 'VPN_PANEL_SUBSCRIPTION_BASE_URL', config.subscriptionBaseUrl);
    updated = this.upsertEnvValue(updated, 'VPN_PANEL_SUBSCRIPTION_PATH', config.subscriptionPath);
    updated = this.upsertEnvValue(updated, 'VPN_PANEL_SUBSCRIPTION_PORT', String(config.subscriptionPort));
    updated = this.upsertEnvValue(updated, 'VPN_PANEL_TLS_ENABLED', String(config.tlsEnabled));

    await this.writeFile(envPath, updated);
  }

  private async httpRequest(options: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const urlObject = new URL(options.url);
      const protocol = urlObject.protocol === 'https:' ? https : http;

      const request = protocol.request(
        {
          hostname: urlObject.hostname,
          port: urlObject.port,
          path: `${urlObject.pathname}${urlObject.search}`,
          method: options.method,
          headers: options.headers,
        },
        (response) => {
          let responseBody = '';
          response.on('data', (chunk) => {
            responseBody += chunk;
          });
          response.on('end', () => {
            resolve({
              statusCode: response.statusCode || 0,
              body: responseBody,
              headers: response.headers,
            });
          });
          response.on('error', reject);
        },
      );

      request.on('error', reject);
      if (options.body) {
        request.write(options.body);
      }
      request.end();
    });
  }
}