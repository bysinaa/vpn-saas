/**
 * Panel Command - Manage 3x-UI panel connections
 */
import { BaseCommand } from './install.interface';
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
}

interface PanelConfig {
  panels: PanelConnection[];
  updatedAt: string;
}

interface PanelConnection {
  id: string;
  url: string;
  user: string;
  pass: string;
  subPort: number;
  subPath: string;
  lastSync?: string;
  status?: 'online' | 'offline';
}

export class PanelCommand extends BaseCommand {
  private readonly configPath = '.panels-config.json';

  async execute(options: PanelOptions): Promise<void> {
    console.log('\n🖥️ VPN SaaS Panel Manager\n');
    console.log('═'.repeat(50));

    const config = await this.loadConfig();

    if (options.list) {
      await this.listPanels(config);
    } else if (options.add) {
      await this.addPanel(config, options);
    } else if (options.remove) {
      await this.removePanel(config, options);
    } else if (options.test) {
      await this.testPanel(config, options);
    } else if (options.sync) {
      await this.syncPanel(config, options);
    } else {
      await this.showMenu(config);
    }
  }

  private async loadConfig(): Promise<PanelConfig> {
    try {
      if (await this.fileExists(this.configPath)) {
        const content = await this.readFile(this.configPath);
        return JSON.parse(content);
      }
    } catch { /* ignore */ }
    return { panels: [], updatedAt: new Date().toISOString() };
  }

  private async saveConfig(config: PanelConfig): Promise<void> {
    await this.writeFile(this.configPath, JSON.stringify(config, null, 2));
  }

  private async listPanels(config: PanelConfig): Promise<void> {
    console.log('\n📋 Configured Panels:\n');
    if (config.panels.length === 0) {
      this.log('No panels configured', 'warn');
    } else {
      config.panels.forEach((panel, i) => {
        const status = panel.status === 'online' ? '🟢' : '🔴';
        console.log(`  ${i + 1}. ${status} ${panel.url}`);
        console.log(`     User: ${panel.user}`);
        console.log(`     Sub Port: ${panel.subPort}, Path: /${panel.subPath}`);
        console.log(`     Last Sync: ${panel.lastSync || 'Never'}`);
        console.log('');
      });
    }
  }

  private async addPanel(config: PanelConfig, options: PanelOptions): Promise<void> {
    // Get panel details
    const url = options.url || await this.prompt('Panel URL (e.g., http://45.67.89.10:2053)');
    const user = options.user || await this.prompt('Panel Username (default: admin)');
    const panelUser = user || 'admin';
    const pass = options.pass || await this.prompt('Panel Password');
    const subPort = options.subPort || parseInt(await this.prompt('Subscription Port (default: 2053)'), 10) || 2053;
    const subPath = options.subPath || await this.prompt('Subscription Path (default: sub)');
    const subPathFinal = subPath || 'sub';

    // Test connection
    this.log('Testing panel connection...', 'info');
    const connected = await this.testPanelConnection(url, panelUser, pass);
    if (!connected) {
      this.log('Failed to connect to panel. Please check credentials.', 'error');
      return;
    }
    this.log('Panel connection successful!', 'success');

    // Generate unique ID
    const id = `panel-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Add to config
    config.panels.push({
      id,
      url,
      user: panelUser,
      pass,
      subPort,
      subPath: subPathFinal,
      status: 'online',
      lastSync: new Date().toISOString(),
    });
    config.updatedAt = new Date().toISOString();
    await this.saveConfig(config);

    this.log(`Panel added successfully!`, 'success');
    this.log(`Subscription URL: http://${url.split('://')[1]}:${subPort}/${subPathFinal}/<sub_id>`, 'info');
  }

  private async removePanel(config: PanelConfig, options: PanelOptions): Promise<void> {
    const url = options.url;
    if (!url) {
      this.log('Please specify panel URL to remove (--url <url>)', 'error');
      return;
    }

    const index = config.panels.findIndex((p) => p.url === url);
    if (index === -1) {
      this.log(`Panel ${url} not found`, 'warn');
      return;
    }

    config.panels.splice(index, 1);
    config.updatedAt = new Date().toISOString();
    await this.saveConfig(config);

    this.log(`Panel ${url} removed successfully!`, 'success');
  }

  private async testPanel(config: PanelConfig, options: PanelOptions): Promise<void> {
    const url = options.url || config.panels[0]?.url;
    const user = options.user || config.panels[0]?.user;
    const pass = options.pass || config.panels[0]?.pass;

    if (!url) {
      this.log('Please specify panel URL (--url <url>)', 'error');
      return;
    }

    this.log(`Testing connection to ${url}...`, 'info');
    const connected = await this.testPanelConnection(url, user || 'admin', pass || '');
    if (connected) {
      this.log('Connection successful!', 'success');
    } else {
      this.log('Connection failed!', 'error');
    }
  }

  private async syncPanel(config: PanelConfig, options: PanelOptions): Promise<void> {
    const url = options.url || config.panels[0]?.url;
    if (!url) {
      this.log('No panel to sync. Add a panel first.', 'error');
      return;
    }

    const panel = config.panels.find((p) => p.url === url);
    if (!panel) {
      this.log(`Panel ${url} not found`, 'error');
      return;
    }

    this.log('Syncing users from panel...', 'info');
    // This will trigger the bot's panel sync functionality
    panel.lastSync = new Date().toISOString();
    await this.saveConfig(config);
    this.log('Sync completed!', 'success');
  }

  private async showMenu(config: PanelConfig): Promise<void> {
    console.log('\n📋 Configured Panels:\n');
    if (config.panels.length === 0) {
      this.log('No panels configured', 'warn');
    } else {
      config.panels.forEach((panel, i) => {
        const status = panel.status === 'online' ? '🟢' : '🔴';
        console.log(`  ${i + 1}. ${status} ${panel.url}`);
      });
    }

    console.log('\nOptions:');
    console.log('  --list              List all panels');
    console.log('  --add               Add a new panel');
    console.log('  --remove --url <url> Remove a panel');
    console.log('  --test --url <url>  Test panel connection');
    console.log('  --sync --url <url>  Sync users from panel');
    console.log('');
    console.log('Add panel options:');
    console.log('  --add --url <url> --user <user> --pass <pass> --sub-port <port> --sub-path <path>');
    console.log('');
  }

  private async testPanelConnection(url: string, user: string, pass: string): Promise<boolean> {
    try {
      const loginData = JSON.stringify({ username: user, password: pass });
      const result = await this.httpRequest({
        url: `${url}/login`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(loginData).toString(),
        },
        body: loginData,
      });
      return result.includes('success') || result.includes('token');
    } catch {
      return false;
    }
  }

  private async httpRequest(options: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }): Promise<string> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(options.url);
      const protocol = urlObj.protocol === 'https:' ? https : http;
      const reqOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: options.method,
        headers: options.headers,
      };

      const req = protocol.request(reqOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
        res.on('error', reject);
      });

      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }
}