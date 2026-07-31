#!/usr/bin/env node
/**
 * resolve-db.js
 *
 * Purpose:
 *  - Read suggested registry (from installer-state.json). Validate connectivity and credentials
 *    for discovered PostgreSQL candidates.
 *  - Present a machine-readable validation result written back to installer-state.json
 *    (non-destructive).
 *  - Provide helpers to generate an isolated Postgres docker-compose snippet (safe: file only).
 *  - Never modifies remote databases, users, or passwords.
 *
 * Behavior summary:
 *  - For each candidate in state.databases.registrySuggested.databases:
 *      - TCP probe host:port
 *      - If candidate.credentials contains a DATABASE_URL or POSTGRES_USER/POSTGRES_PASSWORD,
 *        attempt to use the 'psql' CLI to list databases (best-effort). If 'psql' is missing, record that.
 *  - Write results into installer-state.json under state.databases.validations
 *  - If invoked with --generate-isolated, generates a docker-compose snippet (deploy/infrastructure/postgres/docker-compose.generated.yml)
 *    with a secure password (written to installer-state.json credentials field). Does NOT start the container.
 *
 * Usage:
 *   node cli/installer/resolve-db.js            # validate discovered candidates
 *   node cli/installer/resolve-db.js --generate-isolated  # generate compose to create an isolated postgres for vpn_saas
 *
 * Safety:
 *  - The script never modifies any existing remote instance.
 *  - The generated compose file is created locally; user must run it to instantiate.
 */
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const crypto = require('crypto');
const net = require('net');

const STATE_PATH = path.resolve(process.cwd(), 'installer-state.json');
const GENERATED_COMPOSE = path.resolve(process.cwd(), 'deploy', 'infrastructure', 'postgres', 'docker-compose.generated.yml');

function loadState() {
  try {
    const _sm = require('./state-manager');
    return _sm.loadState(STATE_PATH);
  } catch (e) {
    // fallback to direct read (shouldn't happen)
    try {
      if (!fs.existsSync(STATE_PATH)) return {};
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch (e2) {
      return {};
    }
  }
}

function saveState(state) {
  const _sm = require('./state-manager');
  _sm.saveState(STATE_PATH, state);
}

function runCmd(cmd, opts = {}) {
  const timeout = opts.timeout || 15_000;
  return new Promise((resolve) => {
    exec(cmd, { timeout, shell: true }, (err, stdout, stderr) => {
      resolve({
        success: !err,
        code: err && err.code != null ? err.code : 0,
        stdout: stdout ? String(stdout).trim() : '',
        stderr: stderr ? String(stderr).trim() : '',
        err,
      });
    });
  });
}

function tcpProbe(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let finished = false;
    s.setTimeout(timeout);
    s.on('connect', () => {
      finished = true;
      s.destroy();
      resolve({ ok: true });
    });
    s.on('timeout', () => {
      if (!finished) { finished = true; s.destroy(); resolve({ ok: false, reason: 'timeout' }); }
    });
    s.on('error', (e) => {
      if (!finished) { finished = true; s.destroy(); resolve({ ok: false, reason: 'error', error: String(e) }); }
    });
    s.connect(port, host);
  });
}

function mkRandomPassword(len = 24) {
  return crypto.randomBytes(len).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, len);
}

async function tryPsqlList(dsnCandidate) {
  // dsnCandidate: connection string e.g. postgresql://user:pass@host:port/db
  // We'll try: psql "dsn" -c "\l" -t -A to list databases (psql may not be installed)
  const cmd = `psql "${dsnCandidate}" -c "\\l"`;
  const res = await runCmd(cmd, { timeout: 8000 });
  return res;
}

function buildDsnFromParts({ host, port, user, password, database }) {
  if (!user || !password) return null;
  const userEnc = encodeURIComponent(user);
  const passEnc = encodeURIComponent(password);
  const hostEnc = host || 'localhost';
  const portPart = port ? `:${port}` : '';
  const dbPart = database ? `/${database}` : '/postgres';
  return `postgresql://${userEnc}:${passEnc}@${hostEnc}${portPart}${dbPart}`;
}

async function validateCandidates(candidates) {
  const results = [];
  for (const c of candidates) {
    const host = c.host || 'localhost';
    const port = c.port || 5432;
    console.log(`Validating candidate: source=${c.source} host=${host} port=${port} owner=${c.owner} managed=${c.managed}`);
    const r = { source: c.source, host, port, owner: c.owner, managed: !!c.managed, timestamp: new Date().toISOString(), tcp: null, psql: null, databases: null, notes: [] };

    // 1) TCP probe
    try {
      const tcp = await tcpProbe(host === 'localhost' ? '127.0.0.1' : host, port, 1500);
      r.tcp = tcp;
      if (!tcp.ok) {
        r.notes.push(`TCP probe failed: ${tcp.reason || tcp.error || 'unknown'}`);
        results.push(r);
        continue; // no further checks possible
      }
    } catch (e) {
      r.notes.push(`TCP probe exception: ${String(e)}`);
      results.push(r);
      continue;
    }

    // 2) Try psql if credentials present
    let attemptedPsql = false;
    if (c.credentials && c.credentials.DATABASE_URL) {
      attemptedPsql = true;
      const dsn = c.credentials.DATABASE_URL;
      console.log('  Attempting psql using provided DATABASE_URL (best-effort)...');
      const p = await tryPsqlList(dsn);
      r.psql = { attempted: true, cmdOutput: p.stdout || p.stderr, success: p.success, code: p.code };
      if (p.success && p.stdout) {
        // basic parsing: look for database list lines
        r.databases = p.stdout.split('\n').slice(0, 200).join('\n');
      }
    } else if (c.credentials && c.credentials.POSTGRES_USER && c.credentials.POSTGRES_PASSWORD) {
      attemptedPsql = true;
      const dsn = buildDsnFromParts({ host, port, user: c.credentials.POSTGRES_USER, password: c.credentials.POSTGRES_PASSWORD, database: c.credentials.POSTGRES_DB || 'postgres' });
      if (dsn) {
        console.log('  Attempting psql using POSTGRES_USER/POSTGRES_PASSWORD (best-effort)...');
        const p = await tryPsqlList(dsn);
        r.psql = { attempted: true, dsnUsed: 'redacted', success: p.success, code: p.code, cmdOutput: p.stdout || p.stderr };
        if (p.success && p.stdout) {
          r.databases = p.stdout.split('\n').slice(0, 200).join('\n');
        }
      } else {
        r.psql = { attempted: true, success: false, reason: 'incomplete-credentials' };
      }
    } else {
      r.psql = { attempted: false, reason: 'no-credentials-present' };
      r.notes.push('No credentials present to perform authenticated checks. You may provide credentials via manual configuration or choose to create an isolated Postgres instance.');
    }

    // 3) If psql not available but TCP ok, note that interactive steps will be required
    if (r.psql && r.psql.attempted && r.psql.success === false && (r.psql.cmdOutput && /psql: could not|psql: error|command not found/i.test(r.psql.cmdOutput))) {
      // could be missing psql or auth failure
      if (/command not found/i.test(r.psql.cmdOutput) || /not found: psql/i.test(r.psql.cmdOutput) || /psql: could not/i.test(r.psql.cmdOutput)) {
        r.notes.push('psql CLI may be missing on this host; authenticated checks could not be performed. Consider installing psql or providing DATABASE_URL for validation.');
      } else {
        r.notes.push('Authenticated psql attempt failed. If this instance is managed by 3X-UI, do not modify it; provide credentials or create an isolated DB.');
      }
    }

    results.push(r);
  }
  return results;
}

function generateComposeSnippet({ containerName = 'vpn_saas_postgres', postgresPort = 5432, dbName = 'vpn_saas', postgresUser = 'vpn_saas', postgresPassword = null }) {
  const pwd = postgresPassword || mkRandomPassword(24);
  const snippet = `version: '3.8'
services:
  ${containerName}:
    image: postgres:15
    restart: unless-stopped
    environment:
      - POSTGRES_USER=${postgresUser}
      - POSTGRES_PASSWORD=${pwd}
      - POSTGRES_DB=${dbName}
    volumes:
      - ./deploy/infrastructure/postgres/data:/var/lib/postgresql/data
    ports:
      - "${postgresPort}:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${postgresUser} -d ${dbName} -h localhost -p 5432"]
      interval: 10s
      timeout: 5s
      retries: 5
`;
  return { snippet, password: pwd };
}

async function main() {
  const args = process.argv.slice(2);
  const generateIsolated = args.includes('--generate-isolated');

  const state = loadState();
  state.databases = state.databases || {};
  const registry = (state.databases && state.databases.registrySuggested && state.databases.registrySuggested.databases) || [];

  if (!registry.length && !generateIsolated) {
    console.error('No suggested registry entries found. Run detect-db first, or use --generate-isolated to create a local postgres compose file.');
    process.exit(2);
  }

  // Validate candidates
  const validations = await validateCandidates(registry);

  state.databases.validations = { timestamp: new Date().toISOString(), results: validations };

  try {
    saveState(state);
    console.log('Updated installer-state.json with database validation results.');
  } catch (e) {
    console.error('Failed to save installer state:', e && e.message ? e.message : e);
  }

  // If generate-isolated was requested, create a docker-compose snippet and add to state (but do not run)
  if (generateIsolated) {
    console.log('Generating isolated Postgres docker-compose snippet (file only, not started).');
    const containerName = 'vpn_saas_postgres';
    const postgresPort = 5432;
    const dbName = 'vpn_saas';
    const postgresUser = 'vpn_saas';
    const { snippet, password } = generateComposeSnippet({ containerName, postgresPort, dbName, postgresUser });
    // Ensure directory exists
    try {
      fs.mkdirSync(path.dirname(GENERATED_COMPOSE), { recursive: true });
      fs.writeFileSync(GENERATED_COMPOSE, snippet, 'utf8');
      console.log(`Wrote compose snippet to ${GENERATED_COMPOSE}`);
      // augment state with generated entry (managed=true)
      const genEntry = {
        type: 'postgres',
        host: 'localhost',
        port: postgresPort,
        database: dbName,
        owner: 'tazaxy',
        managed: true,
        source: `generated:${path.relative(process.cwd(), GENERATED_COMPOSE)}`,
        credentials: { POSTGRES_USER: postgresUser, POSTGRES_PASSWORD: password, POSTGRES_DB: dbName },
        generatedAt: new Date().toISOString(),
      };
      state.databases.registrySuggested = state.databases.registrySuggested || { databases: [] };
      // avoid duplicating a localhost:port entry
      const key = `${genEntry.host}:${genEntry.port}`;
      const exists = (state.databases.registrySuggested.databases || []).find((d) => `${d.host}:${d.port}` === key);
      if (!exists) {
        state.databases.registrySuggested.databases = (state.databases.registrySuggested.databases || []).concat([genEntry]);
      } else {
        console.log('A registry entry for this host:port already exists; appended generated credentials to state but did not duplicate registry entry.');
      }
      saveState(state);
      console.log('Generator: updated installer-state.json with the generated registry entry (managed=true).');
      console.log('To instantiate the generated Postgres, run: docker compose -f', GENERATED_COMPOSE, 'up -d');
      console.log('After the container is running, re-run resolve-db.js (without --generate-isolated) to validate and then continue installer flow.');
    } catch (e) {
      console.error('Failed to generate compose snippet:', e && e.message ? e.message : e);
      process.exit(1);
    }
  } else {
    // Print a short human-friendly summary of validations
    console.log('\nValidation summary:');
    for (const v of validations) {
      console.log(`- source=${v.source} host=${v.host} port=${v.port} managed=${v.managed}`);
      console.log(`  tcp: ${v.tcp && v.tcp.ok ? 'OK' : `FAIL (${v.tcp && (v.tcp.reason || v.tcp.error)})`}`);
      if (v.psql) {
        console.log(`  psql attempted: ${v.psql.attempted ? 'yes' : 'no'}`);
        if (v.psql.attempted) {
          console.log(`    success: ${v.psql.success ? 'yes' : 'no'} code=${v.psql.code}`);
          if (v.psql.cmdOutput) {
            console.log('    cmdOutput (truncated):');
            console.log(v.psql.cmdOutput.split('\n').slice(0, 8).join('\n'));
          }
        }
      }
      if (v.notes && v.notes.length) {
        console.log('  notes:');
        for (const n of v.notes) console.log('   -', n);
      }
    }
    console.log('\nNext recommended actions:');
    console.log('- If you chose to reuse an existing instance, ensure credentials are available (installer-state.json or env files).');
    console.log('- If credentials are missing, either provide credentials manually, or generate an isolated Postgres with --generate-isolated and run it.');
    console.log('- Back up any production DB before touching it (scripts/postgres-backup.sh). The installer will not modify externally-managed databases.');
  }
}

main().catch((e) => {
  console.error('resolve-db: unexpected error', e && e.message ? e.message : e);
  process.exit(1);
});