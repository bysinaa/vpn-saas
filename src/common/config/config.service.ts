import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Hierarchical config resolution order (highest priority first):
 *   1. Database (settings table) — runtime-mutable
 *   2. Project .env (process.env / vpn-saas/.env)
 *   3. Shared env (/opt/shared/.env or deploy/infrastructure/shared/.env)
 *   4. Hard-coded defaults
 *
 * Usage:
 *   const value = configService.get('XUI_PANEL_URL');
 *   const dbUrl = configService.get('DATABASE_URL');
 *
 * The application should prefer ConfigService over direct process.env access.
 */
@Injectable()
export class ConfigService implements OnModuleInit {
  private readonly logger = new Logger(ConfigService.name);
  private dbCache = new Map<string, string>();
  private sharedEnv = new Map<string, string>();

  async onModuleInit(): Promise<void> {
    await this.loadSharedEnv();
    this.logger.log(`ConfigService initialised — ${this.sharedEnv.size} shared env vars`);
  }

  // ─── Public API ──────────────────────────────────────────────────────

  /**
   * Resolve a configuration key using the hierarchical priority chain.
   * Returns `fallback` when the key is not found anywhere.
   */
  get(key: string, fallback?: string): string | undefined {
    // 1. Database settings table
    if (this.dbCache.has(key)) {
      return this.dbCache.get(key);
    }

    // 2. Project env (process.env — loaded by NestJS / dotenv from vpn-saas/.env)
    const projectVal = process.env[key];
    if (projectVal !== undefined && projectVal !== '') {
      return projectVal;
    }

    // 3. Shared env (/opt/shared/.env)
    if (this.sharedEnv.has(key)) {
      return this.sharedEnv.get(key);
    }

    // 4. Fallback
    return fallback;
  }

  /**
   * Get a required configuration value. Throws if not found.
   */
  getRequired(key: string): string {
    const value = this.get(key);
    if (value === undefined || value === '') {
      throw new Error(`Required configuration key "${key}" is not set in any configuration source.`);
    }
    return value;
  }

  /**
   * Get a value coerced to a number.
   */
  getNumber(key: string, fallback?: number): number | undefined {
    const raw = this.get(key);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  /**
   * Get a value coerced to a boolean.
   */
  getBoolean(key: string, fallback?: boolean): boolean | undefined {
    const raw = this.get(key);
    if (raw === undefined) return fallback;
    return ['true', '1', 'yes'].includes(raw.toLowerCase());
  }

  /**
   * Get a list from a comma-separated string value.
   */
  getList(key: string, fallback: string[] = []): string[] {
    const raw = this.get(key);
    if (!raw) return fallback;
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /**
   * Return the resolved DATABASE_URL, computed dynamically.
   * This ensures boot-detection results are always reflected.
   */
  getDatabaseUrl(): string | undefined {
    return this.get('DATABASE_URL');
  }

  /**
   * Return the 3X-UI database connection info from shared config.
   */
  getXuiDbConfig(): { type: string; dsn: string } | undefined {
    const type = this.get('XUI_DB_TYPE');
    const dsn = this.get('XUI_DB_DSN');
    if (type && dsn) return { type, dsn };
    return undefined;
  }

  // ─── Internal ────────────────────────────────────────────────────────

  private async loadSharedEnv(): Promise<void> {
    const candidates = [
      // Production path
      '/opt/shared/.env',
      // Dev / repo path
      path.resolve(__dirname, '../../../deploy/infrastructure/shared/.env'),
      // Alternative dev path
      path.resolve(process.cwd(), 'deploy/infrastructure/shared/.env'),
    ];

    for (const envPath of candidates) {
      try {
        if (fs.existsSync(envPath)) {
          const content = fs.readFileSync(envPath, 'utf8');
          this.parseEnvFile(content, this.sharedEnv);
          this.logger.log(`Loaded shared env from ${envPath}`);
          return;
        }
      } catch {
        // continue to next candidate
      }
    }

    this.logger.debug('No shared .env file found — skipping shared env layer');
  }

  private parseEnvFile(content: string, target: Map<string, string>): void {
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;

      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();

      // Remove surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      // Don't override existing env vars or already-set values
      if (!target.has(key) && process.env[key] === undefined) {
        target.set(key, value);
      }
    }
  }
}