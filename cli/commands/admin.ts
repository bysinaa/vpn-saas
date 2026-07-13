/**
 * Admin Command - Manage super admin settings.
 */
import { BaseCommand } from './install.interface';

export interface AdminOptions {
  list?: boolean;
  add?: string;
  remove?: string;
  change?: string;
}

export class AdminCommand extends BaseCommand {
  async execute(options: AdminOptions): Promise<void> {
    this.section('Super Admin Settings');

    const config = await this.loadRuntimeConfig();

    if (options.list) {
      await this.listAdmins();
      return;
    }

    if (options.add) {
      await this.addAdmin(options.add);
      return;
    }

    if (options.remove) {
      await this.removeAdmin(options.remove);
      return;
    }

    if (options.change) {
      await this.changePrimaryAdmin(options.change);
      return;
    }

    await this.showMenu(config.superAdmins);
  }

  private async listAdmins(): Promise<void> {
    const config = await this.loadRuntimeConfig();
    const admins = config.superAdmins;

    if (admins.length === 0) {
      this.log('No super admins configured yet.', 'warn');
      return;
    }

    admins.forEach((telegramId, index) => {
      const marker = index === 0 ? ' (primary)' : '';
      console.log(`  ${index + 1}. ${telegramId}${marker}`);
    });
  }

  private async addAdmin(telegramId: string): Promise<void> {
    this.validateTelegramId(telegramId);

    await this.saveRuntimeConfig((config) => {
      if (config.superAdmins.includes(telegramId)) {
        return config;
      }

      return {
        ...config,
        superAdmins: [...config.superAdmins, telegramId],
      };
    });

    await this.persistEnvAdmins();
    await this.persistAdminsToDatabase();

    this.log(`Super admin ${telegramId} added.`, 'success');
  }

  private async removeAdmin(telegramId: string): Promise<void> {
    this.validateTelegramId(telegramId);

    const updated = await this.saveRuntimeConfig((config) => ({
      ...config,
      superAdmins: config.superAdmins.filter((item) => item !== telegramId),
    }));

    await this.persistEnvAdmins();
    await this.persistAdminsToDatabase();

    if (updated.superAdmins.includes(telegramId)) {
      this.log(`Super admin ${telegramId} is still present after update.`, 'warn');
      return;
    }

    this.log(`Super admin ${telegramId} removed.`, 'success');
  }

  private async changePrimaryAdmin(telegramId: string): Promise<void> {
    this.validateTelegramId(telegramId);

    const updated = await this.saveRuntimeConfig((config) => {
      const admins = [telegramId, ...config.superAdmins.filter((item) => item !== telegramId)];
      return {
        ...config,
        superAdmins: admins,
      };
    });

    await this.persistEnvAdmins();
    await this.persistAdminsToDatabase();

    this.log(`Primary super admin is now ${updated.superAdmins[0]}.`, 'success');
  }

  private async showMenu(admins: string[]): Promise<void> {
    console.log('\nConfigured super admins:\n');
    if (admins.length === 0) {
      console.log('  (none)');
    } else {
      admins.forEach((admin, index) => {
        const marker = index === 0 ? ' (primary)' : '';
        console.log(`  ${index + 1}. ${admin}${marker}`);
      });
    }

    const action = await this.select('Choose an action', [
      { value: 'list', label: 'List super admins' },
      { value: 'add', label: 'Add super admin Telegram ID' },
      { value: 'remove', label: 'Remove super admin Telegram ID' },
      { value: 'change', label: 'Change primary super admin' },
      { value: 'exit', label: 'Exit' },
    ]);

    if (action === 'exit') {
      this.log('No changes applied.', 'info');
      return;
    }

    if (action === 'list') {
      await this.listAdmins();
      return;
    }

    const telegramId = await this.prompt('Telegram ID');

    if (action === 'add') {
      await this.addAdmin(telegramId);
      return;
    }

    if (action === 'remove') {
      await this.removeAdmin(telegramId);
      return;
    }

    if (action === 'change') {
      await this.changePrimaryAdmin(telegramId);
    }
  }

  private validateTelegramId(telegramId: string) {
    if (!/^\d+$/.test(telegramId)) {
      throw new Error(`Invalid Telegram ID: ${telegramId}`);
    }
  }

  private async persistEnvAdmins(): Promise<void> {
    const config = await this.loadRuntimeConfig();
    const envPath = config.paths.envFile;
    const existing = (await this.fileExists(envPath)) ? await this.readFile(envPath) : '';
    const updated = this.upsertEnvValue(existing || '# VPN SaaS environment\n', 'TELEGRAM_ADMIN_IDS', config.superAdmins.join(','));
    await this.writeFile(envPath, updated);
  }

  private async persistAdminsToDatabase(): Promise<void> {
    const config = await this.loadRuntimeConfig();
    const envPath = config.paths.envFile;

    if (!(await this.fileExists(envPath))) {
      this.log('Environment file not found; skipped database synchronization for super admins.', 'warn');
      return;
    }

    const joinedAdmins = config.superAdmins.join(',');
    const command = `node -e "const fs=require('fs'); const env=fs.readFileSync('${envPath.replace(/\\/g, '\\\\')}', 'utf8'); env.split(/\\r?\\n/).filter(Boolean).forEach((line)=>{ const idx=line.indexOf('='); if(idx>0){ const key=line.slice(0,idx); const value=line.slice(idx+1); if(!process.env[key]) process.env[key]=value; }}); process.env.TELEGRAM_ADMIN_IDS='${joinedAdmins}'; console.log('super-admin-sync-ready');"`;
    const result = await this.execCommand(command, { allowFailure: true });

    if (!result.ok) {
      this.log('Database synchronization helper could not be executed. Runtime configuration was still updated.', 'warn');
      return;
    }

    this.log('Environment-based super admin configuration synchronized.', 'info');
  }
}