/**
 * Admin Command - Manage super admin settings
 */
import { BaseCommand } from './install.interface';
import * as fs from 'fs';
import * as path from 'path';

export interface AdminOptions {
  list?: boolean;
  add?: string;
  remove?: string;
}

interface AdminConfig {
  admins: string[];
  updatedAt: string;
}

export class AdminCommand extends BaseCommand {
  private readonly configPath = '.admin-config.json';

  async execute(options: AdminOptions): Promise<void> {
    console.log('\n👤 VPN SaaS Admin Manager\n');
    console.log('═'.repeat(50));

    // Load existing config
    const config = await this.loadConfig();

    if (options.list) {
      await this.listAdmins(config);
    } else if (options.add) {
      await this.addAdmin(config, options.add);
    } else if (options.remove) {
      await this.removeAdmin(config, options.remove);
    } else {
      await this.showMenu(config);
    }
  }

  private async loadConfig(): Promise<AdminConfig> {
    try {
      if (await this.fileExists(this.configPath)) {
        const content = await this.readFile(this.configPath);
        return JSON.parse(content);
      }
    } catch { /* ignore */ }
    return { admins: [], updatedAt: new Date().toISOString() };
  }

  private async saveConfig(config: AdminConfig): Promise<void> {
    await this.writeFile(this.configPath, JSON.stringify(config, null, 2));
  }

  private async listAdmins(config: AdminConfig): Promise<void> {
    console.log('\n📋 Current Super Admins:\n');
    if (config.admins.length === 0) {
      this.log('No admins configured', 'warn');
    } else {
      config.admins.forEach((admin, i) => {
        console.log(`  ${i + 1}. ${admin}`);
      });
    }
    console.log('');
  }

  private async addAdmin(config: AdminConfig, telegramId: string): Promise<void> {
    // Validate Telegram ID (should be numeric)
    if (!/^\d+$/.test(telegramId)) {
      this.log('Invalid Telegram ID. Must be numeric.', 'error');
      return;
    }

    if (config.admins.includes(telegramId)) {
      this.log(`Admin ${telegramId} already exists`, 'warn');
      return;
    }

    config.admins.push(telegramId);
    config.updatedAt = new Date().toISOString();
    await this.saveConfig(config);

    this.log(`Admin ${telegramId} added successfully!`, 'success');
    this.log('Restart the bot for changes to take effect', 'info');
  }

  private async removeAdmin(config: AdminConfig, telegramId: string): Promise<void> {
    const index = config.admins.indexOf(telegramId);
    if (index === -1) {
      this.log(`Admin ${telegramId} not found`, 'warn');
      return;
    }

    config.admins.splice(index, 1);
    config.updatedAt = new Date().toISOString();
    await this.saveConfig(config);

    this.log(`Admin ${telegramId} removed successfully!`, 'success');
    this.log('Restart the bot for changes to take effect', 'info');
  }

  private async showMenu(config: AdminConfig): Promise<void> {
    console.log('\n📋 Current Super Admins:\n');
    if (config.admins.length === 0) {
      this.log('No admins configured', 'warn');
    } else {
      config.admins.forEach((admin, i) => {
        console.log(`  ${i + 1}. ${admin}`);
      });
    }

    console.log('\nOptions:');
    console.log('  --list              List all admins');
    console.log('  --add <telegram_id> Add a new admin');
    console.log('  --remove <telegram_id> Remove an admin');
    console.log('');
  }
}