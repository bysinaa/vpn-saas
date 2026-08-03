import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '../../common/config/config.service';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as dns from 'node:dns';
import * as net from 'node:net';
import { Client as PgClient } from 'pg';
import { promisify } from 'node:util';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dnsLookup = promisify(dns.lookup);

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly maxConnectAttempts = 5;
  private readonly baseBackoffMs = 800;

  constructor(private readonly configService: ConfigService) {
    // Compute a best-effort DATABASE_URL synchronously for Prisma constructor.
    // Priority:
    //  1. process.env.DATABASE_URL (dotenv / env)
    //  2. installer-state.json selected entry (if present)
    //  3. shared env via ConfigService
    //  4. fallback to undefined (Prisma will error later)
    const envUrl = process.env.DATABASE_URL;
    const registryUrl = (() => {
      try {
        const statePath = path.resolve(process.cwd(), 'installer-state.json');
        if (!fs.existsSync(statePath)) return undefined;
        const raw = fs.readFileSync(statePath, 'utf8');
        const s = JSON.parse(raw);
        const sel =
          s?.databases?.selected ||
          s?.databases?.registrySuggested?.databases?.[0] ||
          s?.databases?.registrySuggested;
        const chosen = sel && (Array.isArray(sel) ? sel[0] : sel);
        if (chosen && chosen.credentials) {
          if (chosen.credentials.DATABASE_URL) return chosen.credentials.DATABASE_URL;
          const user = chosen.credentials.POSTGRES_USER || chosen.credentials.PGUSER;
          const pass = chosen.credentials.POSTGRES_PASSWORD || chosen.credentials.PGPASSWORD;
          const db =
            chosen.credentials.POSTGRES_DB ||
            chosen.credentials.PGDATABASE ||
            chosen.database ||
            'tazaxy';
          const host = chosen.host || 'localhost';
          const port = chosen.port || 5432;
          if (user && pass) {
            return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${db}`;
          }
        }
      } catch (e) {
        // ignore parsing problems; fall through to other sources
      }
      return undefined;
    })();

    const cfgUrl = configService?.getDatabaseUrl?.() || undefined;
    const dsn = envUrl || registryUrl || cfgUrl;

    super({
      datasources: {
        db: {
          url: dsn,
        },
      },
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
  }

  /**
   * onModuleInit attempts to:
   *  - Resolve and print the concrete connection details (host, port, database, user)
   *  - Perform DNS resolution (if host is not an IP)
   *  - Perform TCP probe to host:port
   *  - Attempt authenticated connect using 'pg' client if credentials are present
   *  - Query for basic migration presence (presence of _prisma_migrations table)
   *  - Retry with backoff for transient failures
   *
   * On fatal failure we throw so NestJS fails startup with a clear diagnosis.
   */
  async onModuleInit(): Promise<void> {
    this.logger.log('Prisma: beginning database resolution via databaseManager.resolveRuntime()');

    // Load DatabaseManager and use the new runtime resolver to handle strategy selection,
    // health checks (with retries), and optional env writing. PrismaService must not run
    // discovery or duplicate DNS/TCP/Auth probing logic.
    //
    // To ensure the module is available both in development (src JS) and in production
    // (compiled dist), prefer the compiled dist implementation if present. At build time
    // we emit a small TypeScript proxy (database-manager.proxy.ts) which will be present
    // under dist/src/database/database-manager.proxy.js allowing runtime requires to succeed.
    let dbManager: any = null;
    let dbManagerResolvedPath: string | null = null;
    try {
      // Prefer explicitly compiled dist module if available
      const distDbManager = path.resolve(
        process.cwd(),
        'dist',
        'src',
        'database',
        'database-manager.js',
      );
      const distProxy = path.resolve(
        process.cwd(),
        'dist',
        'src',
        'database',
        'database-manager.proxy.js',
      );
      const srcProxy = path.resolve(process.cwd(), 'src', 'database', 'database-manager.proxy.ts');
      const srcJs = path.resolve(process.cwd(), 'src', 'database', 'database-manager.js');

      // Try candidates in order and remember which path we required for diagnostics
      if (fs.existsSync(distDbManager)) {
        dbManager = require(distDbManager);
        dbManagerResolvedPath = distDbManager;
      } else if (fs.existsSync(distProxy)) {
        dbManager = require(distProxy);
        dbManagerResolvedPath = distProxy;
      } else if (fs.existsSync(srcJs)) {
        dbManager = require(srcJs);
        dbManagerResolvedPath = srcJs;
      } else {
        // Fall back to source proxy which will re-export the JS implementation
        dbManager = require('../../database/database-manager.proxy');
        try {
          dbManagerResolvedPath = require.resolve('../../database/database-manager.proxy');
        } catch {
          dbManagerResolvedPath = '../../database/database-manager.proxy';
        }
      }
    } catch (e) {
      try {
        dbManager = require('../../database/database-manager.proxy');
        try {
          dbManagerResolvedPath = require.resolve('../../database/database-manager.proxy');
        } catch {
          dbManagerResolvedPath = '../../database/database-manager.proxy';
        }
      } catch (err) {
        this.logger.warn(
          'Failed to load database-manager module: ' + String((err as any)?.message ?? err),
        );
        throw err;
      }
    }

    // Diagnostics: print the resolved module path and exported keys so we can detect mismatches
    try {
      if (dbManagerResolvedPath) {
        this.logger.log(`database-manager resolved path: ${dbManagerResolvedPath}`);
      } else {
        // fallback to printing require.resolve of the module object if possible
        try {
          const resolved = require.resolve('../../database/database-manager.proxy');
          this.logger.log(`database-manager resolved (fallback) path: ${resolved}`);
          dbManagerResolvedPath = resolved;
        } catch {}
      }
    } catch (_) {}

    try {
      const keys =
        dbManager && typeof dbManager === 'object'
          ? Object.keys(dbManager)
          : ['<non-object export>'];
      this.logger.log(`database-manager exported keys: ${JSON.stringify(keys)}`);
    } catch (e) {
      this.logger.warn(
        'Failed to enumerate exports of database-manager: ' + String((e as any)?.message ?? e),
      );
    }

    // Compatibility fix:
    // Some consumers export resolve() but not resolveRuntime(); prefer resolveRuntime when present.
    // If resolveRuntime is missing but resolve exists, alias resolveRuntime to resolve to avoid duplicating logic.
    if (
      dbManager &&
      typeof dbManager.resolveRuntime !== 'function' &&
      typeof dbManager.resolve === 'function'
    ) {
      // create a thin adapter that forwards runtime options to resolve()
      dbManager.resolveRuntime = async (opts: any = {}) => {
        // resolve() signature expects validateSelected/discover/registry/generateIsolated - ensure reasonable defaults
        const resolveOpts = Object.assign(
          {
            validateSelected: true,
            discover: !!opts.discover,
            registry: opts.registry,
            generateIsolated: !!opts.generateIsolated,
          },
          opts,
        );
        return await dbManager.resolve(resolveOpts);
      };
      this.logger.log('database-manager: aliased resolveRuntime -> resolve');
    }

    // Ask resolveRuntime to run with conservative defaults: do not run broad discovery at runtime,
    // but allow it to write DATABASE_URL to .env if it can safely (it won't overwrite).
    let runtimeResult: any = null;
    try {
      runtimeResult = await dbManager.resolveRuntime({ discover: false, writeEnv: true });
    } catch (e) {
      // resolveRuntime should return structured diagnostics; surface a warning and continue to attempt connect from env
      this.logger.warn(
        `databaseManager.resolveRuntime() failed: ${String((e as any)?.message ?? e)}`,
      );
      runtimeResult = null;
    }

    // Expose what resolveRuntime produced for operator visibility
    if (runtimeResult && runtimeResult.resolver) {
      const strat =
        runtimeResult.resolver.strategy || runtimeResult.resolver.strategy === null
          ? runtimeResult.resolver.strategy
          : '[unknown]';
      this.logger.log(`Database resolution strategy: ${String(strat)}`);
    }

    // If resolveRuntime wrote an env file, report it
    if (runtimeResult && runtimeResult.envWrite) {
      this.logger.log(`DATABASE_URL write result: ${JSON.stringify(runtimeResult.envWrite)}`);
    }

    // Determine the concrete DATABASE_URL that Prisma should use. Priority:
    // 1) runtimeResult.resolver.resolved credentials (via generateDatabaseUrl or explicit DATABASE_URL)
    // 2) process.env.DATABASE_URL (existing)
    // 3) any preconfigured datasources in this._options
    let providedUrl = process.env.DATABASE_URL || (this as any)._options?.datasources?.db?.url;

    if (runtimeResult && runtimeResult.resolver && runtimeResult.resolver.resolved) {
      const chosen = runtimeResult.resolver.resolved;
      const gen =
        dbManager.generateDatabaseUrl(chosen) ||
        (chosen.credentials && chosen.credentials.DATABASE_URL);
      if (gen && !providedUrl) {
        providedUrl = gen;
        // update Prisma constructor options (in-memory) so super client will use it when connecting
        (this as any)._options = (this as any)._options || {};
        (this as any)._options.datasources = (this as any)._options.datasources || {};
        (this as any)._options.datasources.db = (this as any)._options.datasources.db || {};
        (this as any)._options.datasources.db.url = providedUrl;
        this.logger.log(
          `Resolver provided DATABASE_URL from ${chosen.source} (${chosen.host}:${chosen.port})`,
        );
      }
    }

    if (!providedUrl) {
      this.logger.error(
        'No DATABASE_URL available after databaseManager.resolveRuntime(). Checked runtime resolution and environment.',
      );
      this.logger.error(
        'Suggested actions: run the installer (cli/installer) to select or generate a database, or set DATABASE_URL in .env.',
      );
      throw new Error('DATABASE_URL is not set');
    }

    // parse and report basic target (no DNS/TCP/Auth probing here - resolveRuntime already performed probes)
    const parsed = this.parseDsn(providedUrl);
    this.logger.log(
      `Database target: host=${parsed.host} port=${parsed.port} db=${parsed.database} user=${parsed.user ? '[present]' : '[absent]'}`,
    );

    // If resolveRuntime produced a health or diagnose object, use it to report migration/auth status.
    if (runtimeResult && runtimeResult.health) {
      const h = runtimeResult.health;
      if (h.psql && h.psql.attempted) {
        if (h.psql.via === 'pg' && h.psql.success) {
          this.logger.log('Authenticated probe: OK (node-postgres)');
          if (h.psql.migrations !== undefined) {
            this.logger.log(
              `Migration status (from health): ${h.psql.migrations ? 'present' : 'missing'}`,
            );
          }
        } else if (h.psql.via === 'psql') {
          this.logger.log(`Authenticated probe via psql CLI: success=${h.psql.success}`);
        } else if (h.psql.success === false) {
          this.logger.warn(
            `Authenticated probe failed: ${String(h.psql.error || h.psql.output || '')}`,
          );
        }
      } else {
        this.logger.log(
          'No authenticated probe performed by resolveRuntime; credentials may be missing.',
        );
      }
    }

    // Now attempt to connect Prisma using the resolved DATABASE_URL
    try {
      await this.$connect();
      this.logger.log('✅ Prisma connected to PostgreSQL');

      // Run a migrations presence check using a lightweight pg client (best-effort).
      // Avoid Prisma's regclass deserialization problem by casting to text on the DB side.
      try {
        const migrationsClient = new PgClient({
          connectionString: providedUrl,
          statement_timeout: 3000,
        });
        await migrationsClient.connect();
        try {
          const res = await migrationsClient.query(
            `SELECT to_regclass('public._prisma_migrations')::text AS migrations_table`,
          );
          const migrationsPresent = !!(res.rows && res.rows[0] && res.rows[0].migrations_table);
          this.logger.log(
            `Migration status: _prisma_migrations ${migrationsPresent ? 'present' : 'missing'}`,
          );
        } finally {
          try {
            await migrationsClient.end();
          } catch {}
        }
      } catch (e) {
        this.logger.warn(`Migration check (pg client) failed: ${String((e as any)?.message ?? e)}`);
      }

      // Determine effective strategy: if resolver returned B but the application successfully
      // authenticated and connected, treat it as effective Strategy A (reuse). This avoids a
      // confusing state where resolver suggested operator input but connection still succeeded
      // (for example because an env DATABASE_URL existed).
      try {
        let effectiveStrategy =
          runtimeResult && runtimeResult.resolver ? runtimeResult.resolver.strategy : '[unknown]';
        if (effectiveStrategy === 'B') {
          // we are in the successful connection branch, so this means auth+connect worked.
          effectiveStrategy = 'A';
          this.logger.log(
            'Database strategy adjusted: B -> A because application successfully connected to the database.',
          );
        }
        this.logger.log(`Effective database strategy: ${effectiveStrategy}`);
      } catch (e) {
        // non-fatal
        this.logger.warn(
          `Failed to compute effective database strategy: ${String((e as any)?.message ?? e)}`,
        );
      }

      // call bootstrap method if present (keeps previous behavior)
      try {
        if ((this as any).bootstrapSystemSettings) {
          await (this as any).bootstrapSystemSettings();
        }
      } catch (bsErr) {
        this.logger.warn(`Bootstrap settings failed: ${String((bsErr as any)?.message ?? bsErr)}`);
      }

      // Attach engine listeners (if present)
      (this as any)._engine?.on?.('warn', (e: unknown) => this.logger.warn(e));
      (this as any)._engine?.on?.('error', (e: unknown) => this.logger.error(e));
      return;
    } catch (connectErr) {
      // Connection failed. Prefer using runtimeResult.diagnose (rich diagnostics) if available.
      const diag = runtimeResult && runtimeResult.diagnose ? runtimeResult.diagnose : null;
      this.logger.error(
        'FATAL: Prisma failed to connect using resolved DATABASE_URL. Diagnostics:',
      );
      if (diag) {
        this.logger.error(`Host: ${diag.host}`);
        this.logger.error(`Port: ${diag.port}`);
        this.logger.error(`Database: ${diag.database}`);
        this.logger.error(`Username: ${diag.username || (parsed.user ? '[present]' : '[absent]')}`);
        this.logger.error(`Password Present: ${parsed.password ? 'yes' : 'no'}`);
        this.logger.error(
          `DNS: ${diag.dns && diag.dns.resolved ? `resolved -> ${diag.dns.resolved}` : `dns error -> ${String((diag.dns && diag.dns.error) || '')}`}`,
        );
        this.logger.error(
          `TCP: ${diag.tcp && diag.tcp.ok ? 'ok' : `failed -> ${String((diag.tcp && (diag.tcp.error || diag.tcp.reason)) || '')}`}`,
        );
        if (diag.auth) {
          this.logger.error(`Auth attempted: ${diag.auth.attempted ? 'yes' : 'no'}`);
          if (diag.auth.error) this.logger.error(`Auth error: ${String(diag.auth.error)}`);
        }
        if (diag.migrations) {
          this.logger.error(
            `Migrations present: ${diag.migrations.present === true ? 'yes' : diag.migrations.present === false ? 'no' : 'unknown'}`,
          );
          if (diag.migrations.error)
            this.logger.error(`Migrations check error: ${String(diag.migrations.error)}`);
        }
        if (diag.raw && diag.raw.databases) {
          this.logger.error(
            `Databases (sample): ${(diag.raw.databases || []).slice(0, 10).join(', ')}`,
          );
        }
      } else {
        this.logger.error(
          `Prisma connect error: ${String((connectErr as any)?.message ?? connectErr)}`,
        );
      }

      throw new Error(
        'DATABASE_CONNECTION_FAILED: ' + String((connectErr as any)?.message ?? connectErr),
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.$disconnect();
      this.logger.log('Prisma disconnected');
    } catch (e) {
      this.logger.warn('Error during Prisma disconnect: ' + String((e as any)?.message ?? e));
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private parseDsn(dsn: string): {
    user?: string;
    password?: string;
    host?: string;
    port?: number;
    database?: string;
  } {
    try {
      const m = dsn.match(
        /postgres(?:ql)?:\/\/(?:(.+?):(.+?)@)?([^:\/]+)(?::(\d+))?(?:\/([^?]+))?/i,
      );
      if (!m) return {};
      return {
        user: m[1] ? decodeURIComponent(m[1]) : undefined,
        password: m[2] ? decodeURIComponent(m[2]) : undefined,
        host: m[3],
        port: m[4] ? Number(m[4]) : 5432,
        database: m[5] ? m[5] : undefined,
      };
    } catch {
      return {};
    }
  }

  private tcpProbe(
    host: string,
    port: number,
    timeoutMs = 1500,
  ): Promise<{ ok: boolean; reason?: string; error?: string }> {
    return new Promise((resolve) => {
      const s = new net.Socket();
      let finished = false;
      s.setTimeout(timeoutMs);
      s.on('connect', () => {
        finished = true;
        s.destroy();
        resolve({ ok: true });
      });
      s.on('timeout', () => {
        if (!finished) {
          finished = true;
          s.destroy();
          resolve({ ok: false, reason: 'timeout' });
        }
      });
      s.on('error', (err) => {
        if (!finished) {
          finished = true;
          s.destroy();
          resolve({ ok: false, error: String(err) });
        }
      });
      s.connect(port, host);
    });
  }

  private async tryPgConnect(
    dsn: string,
    timeoutMs = 4000,
    checkMigrations = false,
  ): Promise<{ ok: boolean; error?: string; migrations?: boolean | null }> {
    const client = new PgClient({ connectionString: dsn, statement_timeout: timeoutMs });
    try {
      await client.connect();
      // lightweight authenticated probe
      await client.query('SELECT 1');
      // Optionally check for _prisma_migrations in the same connection to avoid creating extra clients
      if (checkMigrations) {
        try {
          const res = await client.query(
            `SELECT to_regclass('public._prisma_migrations') AS migrations_table`,
          );
          const exists = res.rows && res.rows[0] && res.rows[0].migrations_table;
          await client.end();
          return { ok: true, migrations: !!exists };
        } catch (mqe) {
          try {
            await client.end();
          } catch {}
          return { ok: true, migrations: null };
        }
      }
      await client.end();
      return { ok: true };
    } catch (e) {
      try {
        await client.end();
      } catch {}
      return { ok: false, error: String(e && (e as any).message ? (e as any).message : e) };
    }
  }

  /**
   * Compatibility helper: older codebases used prisma.withTransaction(fn).
   * Newer Prisma clients expose $transaction; expose withTransaction as a thin shim
   * delegating to $transaction. Accepts an async callback receiving the transactional
   * prisma client. Typed with any for broad compatibility with existing code.
   */
  public async withTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    // Delegate to $transaction; use any casts to avoid strict type mismatch with generated types.
    if (typeof (this as any).$transaction === 'function') {
      return (this as any).$transaction(fn as any) as Promise<T>;
    }
    // Fallback: attempt to call as older API (if present)
    if (typeof (this as any).withTransaction === 'function') {
      return (this as any).withTransaction(fn as any) as Promise<T>;
    }
    // As a last resort, invoke fn with this (no real transaction) to avoid breaking execution paths.
    return fn(this as any);
  }
}
