/**
 * Minimal DatabaseManager runtime implementation.
 *
 * This module implements the runtime API surface expected by:
 *  - cli/installer/database-manager.js (CLI wrappers)
 *  - cli/installer/* wrappers (discover/validate/persist)
 *  - src/common/prisma/prisma.service.ts (resolveRuntime, generateDatabaseUrl, resolve, etc)
 *
 * Implementation principles:
 *  - Non-destructive by default. Do not change external DBs.
 *  - Conservative discovery when called via resolveRuntime({ discover: false }).
 *  - Provide validate(), discover(), persist(), resolveRuntime(), resolve(), generateDatabaseUrl().
 *  - Work with installer-state.json via existing CLI state-manager.
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const dns = require('dns').promises;
const { Client: PgClient } = require('pg');
const { createPostgresDetector } = require('../../cli/installer/postgres-detector');

// helper to load/save installer-state.json using same shape as CLI state-manager
function loadState(statePath) {
  try {
    if (!fs.existsSync(statePath)) return {};
    return JSON.parse(fs.readFileSync(statePath, 'utf8') || '{}');
  } catch (e) {
    return {};
  }
}
function saveState(statePath, state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

async function tcpProbe(host, port, timeoutMs = 1500) {
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

function generateDatabaseUrl(entry) {
  if (!entry) return null;
  if (entry.credentials && entry.credentials.DATABASE_URL) return entry.credentials.DATABASE_URL;
  const user = entry.credentials && (entry.credentials.POSTGRES_USER || entry.credentials.PGUSER);
  const pass = entry.credentials && (entry.credentials.POSTGRES_PASSWORD || entry.credentials.PGPASSWORD);
  const db = (entry.credentials && (entry.credentials.POSTGRES_DB || entry.credentials.PGDATABASE)) || entry.database || 'tazaxy';
  const host = entry.host || 'localhost';
  const port = entry.port || 5432;
  if (user && pass) {
    return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${db}`;
  }
  return null;
}

async function attemptAuth(entry, timeoutMs = 2000) {
  const res = { attempted: false, success: false, error: null, via: 'pg', migrations: undefined };
  const url = generateDatabaseUrl(entry) || (entry.credentials && entry.credentials.DATABASE_URL);
  if (!url) {
    return res;
  }
  res.attempted = true;
  const client = new PgClient({ connectionString: url, statement_timeout: timeoutMs });
  try {
    await client.connect();
    // check migrations table
    try {
      const r = await client.query(`SELECT to_regclass('public._prisma_migrations')::text AS migrations_table`);
      res.migrations = !!(r.rows && r.rows[0] && r.rows[0].migrations_table);
    } catch (e) {
      res.migrations = undefined;
    }
    res.success = true;
  } catch (e) {
    res.error = String(e);
    res.success = false;
  } finally {
    try {
      await client.end();
    } catch {}
  }
  return res;
}

/**
 * writeEnvDatabaseUrl(url)
 * Writes a DATABASE_URL line to the project's .env file if none exists.
 * Reuses the same behavior used by resolveRuntime(): never overwrite existing DATABASE_URL,
 * perform a safe append and return a structured result.
 */
function writeEnvDatabaseUrl(url) {
  try {
    if (!url) return { written: false, reason: 'no_url' };
    const existingEnvFile = path.resolve(process.cwd(), '.env');
    const hasExistingDbUrl =
      !!process.env.DATABASE_URL ||
      (fs.existsSync(existingEnvFile) && fs.readFileSync(existingEnvFile, 'utf8').includes('DATABASE_URL='));
    if (!hasExistingDbUrl) {
      const append = `DATABASE_URL=${url}\n`;
      try {
        fs.appendFileSync(existingEnvFile, append, { encoding: 'utf8', flag: 'a' });
        return { written: true, file: existingEnvFile };
      } catch (e) {
        return { written: false, error: String(e) };
      }
    } else {
      return { written: false, reason: 'existing_database_url' };
    }
  } catch (e) {
    return { written: false, error: String(e) };
  }
}

/**
 * discover()
 * Conservative discovery: examine installer-state.json, environment, docker-compose files (deploy/infrastructure/postgres)
 * Does NOT start/stop containers. Returns a structured result with discovered array and registrySuggested.
 */
async function discover(opts = {}) {
  // Centralized, read-only discovery. Legacy management helpers below are only
  // used by explicit install/restore commands and are not detection paths.
  const result = await createPostgresDetector({ runtime: opts.runtime }).discover(opts);
  return {
    discovered: result.candidates.map((candidate) => ({ source: candidate.source, type: 'postgres', host: candidate.connection.host, port: candidate.connection.port, database: candidate.connection.database, ready: candidate.ready })),
    registrySuggested: { databases: [] },
    notes: result.diagnostics,
    result,
  };

}

/**
 * persist(entry)
 * Persist a selected database entry into installer-state.json as state.databases.selected
 */
async function persist(entry) {
  const statePath = path.resolve(process.cwd(), 'installer-state.json');
  const state = loadState(statePath) || {};
  state.databases = state.databases || {};
  state.databases.selected = entry;
  try {
    saveState(statePath, state);
  } catch (e) {
    throw new Error('Failed to write installer-state.json: ' + String(e));
  }
  return true;
}

/**
 * validate({ registry, generateIsolated })
 * Validate provided registry or generate an isolated compose entry.
 * - If registry provided: probe hosts, attempt auth where credentials exist, and persist validations in installer-state.json
 * - If generateIsolated: generate a docker-compose.generated.yml in deploy/infrastructure/postgres/docker-compose.generated.yml
 * This function is intentionally conservative and non-destructive.
 */
async function validate(opts = {}) {
  const statePath = path.resolve(process.cwd(), 'installer-state.json');
  const state = loadState(statePath) || {};
  const results = [];

  const registry = opts.registry || (state.databases && state.databases.registrySuggested && state.databases.registrySuggested.databases) || [];

  for (const r of registry) {
    const host = r.host || 'localhost';
    const port = r.port || 5432;
    const tcp = await tcpProbe(host, port, 1000);
    const auth = await attemptAuth(r);
    const item = {
      source: r.source || 'provided',
      host,
      port,
      tcp,
      psql: { attempted: auth.attempted, success: auth.success, error: auth.error },
      migrations: auth.migrations,
      notes: [],
    };
    results.push(item);
  }

  if (opts.generateIsolated) {
    // create a generated compose file (DO NOT start)
    try {
      const destDir = path.resolve(process.cwd(), 'deploy', 'infrastructure', 'postgres');
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      const generatedCompose = path.join(destDir, 'docker-compose.generated.yml');
      const generatedEnv = path.join(destDir, 'docker-compose.generated.env');
      const creds = {
        POSTGRES_USER: 'tazaxy',
        POSTGRES_PASSWORD: Math.random().toString(36).slice(2, 14),
        POSTGRES_DB: 'tazaxy',
      };
      const compose = `version: '3.8'
services:
  vpn-postgres:
    image: postgres:15
    restart: unless-stopped
    env_file:
      - ./docker-compose.generated.env
    ports:
      - "5432:5432"
    volumes:
      - tazaxy_pgdata:/var/lib/postgresql/data

volumes:
  tazaxy_pgdata:
`;
      fs.writeFileSync(generatedCompose, compose, 'utf8');
      const envText = Object.entries(creds).map(([k, v]) => `${k}=${v}`).join('\\n') + '\\n';
      fs.writeFileSync(generatedEnv, envText, 'utf8');
      // record generated entry in state as managed
      state.databases = state.databases || {};
      state.databases.registrySuggested = state.databases.registrySuggested || { databases: [] };
      const genEntry = {
        source: `generated:deploy/infrastructure/postgres/docker-compose.generated.yml`,
        host: 'localhost',
        port: 5432,
        database: creds.POSTGRES_DB,
        owner: 'tazaxy',
        managed: true,
        credentials: creds,
      };
      state.databases.registrySuggested.databases.unshift(genEntry);
      saveState(statePath, state);
      results.push({ source: 'generated-compose', generatedPath: generatedCompose, generatedEnv, entry: genEntry });
    } catch (e) {
      results.push({ source: 'generated-compose-failed', error: String(e) });
    }
  }

  // persist validations summary
  state.databases = state.databases || {};
  state.databases.validations = { results };
  try {
    saveState(statePath, state);
  } catch (e) {
    // ignore
  }

  return { validations: results, registrySuggested: (state.databases && state.databases.registrySuggested) || null };
}

/**
 * resolve(opts)
 * Backwards-compatible resolve() implementation used by some consumers.
 * Accepts options: validateSelected, discover, registry, generateIsolated.
 * Returns structured result: { resolver: { strategy, resolved }, registrySuggested, state, notes, health, diagnose, envWrite }
 */
async function resolve(opts = {}) {
  // Map to new resolveRuntime shape
  return await resolveRuntime(opts);
}

/**
 * resolveRuntime(opts)
 * Main runtime resolver used by PrismaService. Conservative defaults:
 *  - discover: false (don't do broad discovery)
 *  - writeEnv: true (but do not overwrite existing DATABASE_URL)
 * Behavior:
 *  - If installer-state.json has selected entry with credentials -> strategy A candidate
 *  - If process.env.DATABASE_URL present -> treat as existing env (A)
 *  - If registrySuggested has managed generated entry -> pick it if no env present
 *  - If credentials missing, return strategy 'B' (existing detected but credentials unavailable)
 *  - If no DB detected, strategy 'C' (generate)
 *
 * The function returns rich diagnostics (health, diagnose) for PrismaService to log.
 */
async function resolveRuntime(opts = {}) {
  const statePath = path.resolve(process.cwd(), 'installer-state.json');
  const state = loadState(statePath) || {};
  const writeEnv = !!opts.writeEnv;
  const discoverFlag = !!opts.discover;

  const result = { resolver: { strategy: null, resolved: null }, state: state, envWrite: null, health: null, diagnose: null, notes: [] };

  // 1) If process.env.DATABASE_URL exists, prefer it (Strategy A)
  if (process.env.DATABASE_URL) {
    result.resolver.strategy = 'A';
    result.resolver.resolved = { source: 'env:DATABASE_URL', credentials: { DATABASE_URL: process.env.DATABASE_URL }, managed: false };
    result.notes.push({ type: 'env', message: 'DATABASE_URL found in environment' });
  } else if (state.databases && state.databases.selected) {
    // selected entry present in installer-state.json
    const sel = state.databases.selected;
    // if credentials present and contain DATABASE_URL or user/pass -> we can try reuse (A)
    const creds = sel.credentials || {};
    if (creds.DATABASE_URL || (creds.POSTGRES_USER && creds.POSTGRES_PASSWORD)) {
      result.resolver.strategy = 'A';
      result.resolver.resolved = sel;
      result.notes.push({ type: 'selected', message: 'Selected database found in installer-state.json' });
    } else {
      // existing db discovered but no credentials -> Strategy B
      result.resolver.strategy = 'B';
      result.resolver.resolved = sel;
      result.notes.push({ type: 'selected', message: 'Selected database present but credentials missing' });
    }
  } else if (state.databases && state.databases.registrySuggested && state.databases.registrySuggested.databases && state.databases.registrySuggested.databases.length) {
    // suggested entries exist (may include generated)
    const first = state.databases.registrySuggested.databases[0];
    if (first.managed && first.credentials) {
      result.resolver.strategy = 'A';
      result.resolver.resolved = first;
      result.notes.push({ type: 'suggested', message: 'Using managed suggested entry' });
    } else {
      // registry detected but maybe no creds
      result.resolver.strategy = 'B';
      result.resolver.resolved = first;
      result.notes.push({ type: 'suggested', message: 'Registry suggested entry found' });
    }
  } else {
    // No DB known. If discoverFlag is true we can run discover(), otherwise propose generate (C)
    if (discoverFlag) {
      const disc = await discover();
      if (disc.registrySuggested && disc.registrySuggested.databases && disc.registrySuggested.databases.length) {
        const first = disc.registrySuggested.databases[0];
        result.resolver.strategy = first.credentials ? 'A' : 'B';
        result.resolver.resolved = first;
      } else if (disc.discovered && disc.discovered.length) {
        const first = disc.discovered[0];
        result.resolver.strategy = 'B';
        result.resolver.resolved = first;
      } else {
        result.resolver.strategy = 'C';
      }
    } else {
      result.resolver.strategy = 'C';
    }
  }

  // If strategy C -> generate an isolated compose entry but do not start it unless generateIsolated true
  if (result.resolver.strategy === 'C') {
    // generate but only if generateIsolated flag is passed
    if (opts.generateIsolated) {
      await validate({ generateIsolated: true });
      // reload state
      const newState = loadState(statePath);
      result.state = newState;
      result.registrySuggested = (newState.databases && newState.databases.registrySuggested) || null;
      if (result.registrySuggested && result.registrySuggested.databases && result.registrySuggested.databases.length) {
        result.resolver.strategy = 'A';
        result.resolver.resolved = result.registrySuggested.databases[0];
      }
    } else {
      result.notes.push({ type: 'strategy', message: 'Strategy C - no DB detected' });
    }
  }

  // Health & diagnose: attempt tcp probe and auth attempt where reasonable, but keep timeouts small
  try {
    const chosen = result.resolver.resolved;
    const diag = { host: null, port: null, database: null, username: null, dns: null, tcp: null, auth: null, migrations: null, raw: {} };
    if (chosen) {
      diag.host = chosen.host || 'localhost';
      diag.port = chosen.port || 5432;
      diag.database = chosen.database || (chosen.credentials && (chosen.credentials.POSTGRES_DB || chosen.credentials.PGDATABASE)) || null;
      diag.username = chosen.credentials && (chosen.credentials.POSTGRES_USER || chosen.credentials.PGUSER) ? '[present]' : null;
      // DNS
      try {
        const r = await dns.lookup(diag.host);
        diag.dns = { resolved: r.address };
      } catch (e) {
        diag.dns = { error: String(e) };
      }
      // TCP
      try {
        const tcp = await tcpProbe(diag.host, diag.port, 1000);
        diag.tcp = tcp;
      } catch (e) {
        diag.tcp = { ok: false, error: String(e) };
      }
      // Auth
      try {
        const auth = await attemptAuth(chosen, 1500);
        diag.auth = auth;
        diag.migrations = auth.migrations;
      } catch (e) {
        diag.auth = { attempted: false, error: String(e) };
      }
      result.health = { psql: diag.auth, tcp: diag.tcp, dns: diag.dns, migrations: diag.migrations };
      result.diagnose = { host: diag.host, port: diag.port, database: diag.database, username: diag.username, dns: diag.dns, tcp: diag.tcp, auth: diag.auth, migrations: diag.migrations, raw: result.state };
    }
  } catch (e) {
    // ignore diagnostics failures
  }

  // env writing: only write if writeEnv true AND there is no existing DATABASE_URL in env or .env
  if (writeEnv && result.resolver && result.resolver.resolved) {
    try {
      const url = generateDatabaseUrl(result.resolver.resolved);
      if (url) {
        result.envWrite = writeEnvDatabaseUrl(url);
      } else {
        result.envWrite = { written: false, reason: 'no_url_generated' };
      }
    } catch (e) {
      result.envWrite = { written: false, error: String(e) };
    }
  }

  return result;
}

module.exports = {
  discover,
  validate,
  persist,
  resolve,
  resolveRuntime,
  generateDatabaseUrl,
  writeEnvDatabaseUrl,
  // legacy alias
  resolveRuntime: resolveRuntime,
};
