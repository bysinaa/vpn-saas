import { spawn } from 'child_process';
import * as path from 'path';
import { BaseCommand } from './install.interface';

export interface CloudflareOptions {
  domain?: string;
  panelSubdomain?: string;
  subscriptionSubdomain?: string;
  tunnel?: string;
}

export class CloudflareCommand extends BaseCommand {
  async execute(options: CloudflareOptions): Promise<void> {
    this.section('Cloudflare Tunnel for 3X-UI');
    if (process.platform !== 'linux')
      throw new Error('Cloudflare Tunnel setup must run on the Linux server');
    const args = [path.join(this.workspaceRoot, 'scripts', 'setup-cloudflare-xui.sh')];
    const add = (flag: string, value?: string) => {
      if (value) args.push(flag, value);
    };
    add('--domain', options.domain);
    add('--panel-subdomain', options.panelSubdomain);
    add('--subscription-subdomain', options.subscriptionSubdomain);
    add('--tunnel', options.tunnel);
    await new Promise<void>((resolve, reject) => {
      const child = spawn('bash', args, { cwd: this.workspaceRoot, stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`Cloudflare setup exited with code ${code ?? 1}`)),
      );
    });
    this.log('Cloudflare panel and subscription routes configured.', 'success');
  }
}
