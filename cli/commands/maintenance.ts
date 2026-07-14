import { BaseCommand } from './install.interface';

export interface MaintenanceOptions {
  update?: boolean;
  uninstall?: boolean;
  install3xui?: boolean;
  yes?: boolean;
  verbose?: boolean;
}

export class MaintenanceCommand extends BaseCommand {
  private readonly xuiInstallUrl = 'https://raw.githubusercontent.com/mhsanaei/3x-ui/master/install.sh';

  async execute(options: MaintenanceOptions): Promise<void> {
    this.setExecutionMode(options);
    this.section('Platform Maintenance');

    if (options.update) {
      await this.updatePlatform();
      return;
    }

    if (options.uninstall) {
      await this.uninstallPlatform();
      return;
    }

    if (options.install3xui) {
      await this.install3xui();
      return;
    }

    await this.showMenu();
  }

  private async showMenu(): Promise<void> {
    const action = await this.select('Choose a maintenance action', [
      { value: 'update', label: 'Check for updates and pull latest project code' },
      { value: 'install3xui', label: 'Install or repair 3X-UI' },
      { value: 'uninstall', label: 'Fully uninstall the platform' },
      { value: 'exit', label: 'Exit' },
    ]);

    if (action === 'exit') {
      this.log('No maintenance action selected.', 'info');
      return;
    }

    if (action === 'update') {
      await this.updatePlatform();
      return;
    }

    if (action === 'install3xui') {
      await this.install3xui();
      return;
    }

    await this.uninstallPlatform();
  }

  private async updatePlatform(): Promise<void> {
    const gitExists = await this.fileExists(`${this.workspaceRoot}/.git`);
    if (!gitExists) {
      throw new Error('Update requires a git clone of the project.');
    }

    await this.execOrThrow('git fetch --all --prune');
    const status = await this.execOrThrow('git status --short --branch');
    const pull = await this.execOrThrow('git pull --ff-only');
    await this.execOrThrow('npm install', { timeout: 300000 });
    await this.execOrThrow('npm run cli:build', { timeout: 300000 });

    this.log('Project updated successfully.', 'success');
    if (status.stdout.trim()) {
      console.log(status.stdout.trim());
    }
    if (pull.stdout.trim()) {
      console.log(pull.stdout.trim());
    }
  }

  private async install3xui(): Promise<void> {
    if (!this.isRootUser()) {
      throw new Error('3X-UI installation requires root privileges.');
    }

    await this.execOrThrow(`curl -fsSL ${this.xuiInstallUrl} -o /tmp/3x-ui-install.sh`, { timeout: 120000 });
    await this.execOrThrow('chmod +x /tmp/3x-ui-install.sh');
    await this.execOrThrow('bash /tmp/3x-ui-install.sh', { timeout: 300000 });
    this.log('3X-UI installation completed.', 'success');
  }

  private async uninstallPlatform(): Promise<void> {
    if (!this.isRootUser()) {
      throw new Error('Full uninstall requires root privileges.');
    }

    const confirmed = await this.confirm('This will stop containers, remove runtime files, and uninstall the global tazaxy command. Continue?', false);
    if (!confirmed) {
      this.log('Uninstall cancelled.', 'warn');
      return;
    }

    await this.execCommand('docker compose down -v', { allowFailure: true, timeout: 300000 });
    await this.execCommand('rm -f /usr/local/bin/tazaxy /usr/local/bin/vpn-cli', { allowFailure: true });
    await this.execCommand(`rm -rf "${this.runtimeDir}"`, { allowFailure: true });
    await this.execCommand(`rm -f "${this.defaultEnvPath}"`, { allowFailure: true });

    this.log('Platform runtime and launchers removed from this server.', 'success');
    console.log(`Project directory kept at: ${this.workspaceRoot}`);
    console.log('Remove the project directory manually if you also want the source code deleted.');
  }
}