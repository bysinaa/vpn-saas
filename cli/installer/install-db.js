#!/usr/bin/env node
/**
 * install-db.js
 *
 * Orchestrates an adaptive database installation/selection flow:
 * 1) Run discovery (detect-db.js)
 * 2) Validate candidates (resolve-db.js)
 * 3) If a usable DATABASE_URL exists in project .env, validate and persist selection
 * 4) Else pick a validated candidate with credentials (prefer non-3x-ui owners)
 * 5) If candidate lacks credentials, launch interactive db-decision.js helper
 * 6) Persist chosen selection into installer-state.json and write DATABASE_URL into .env (non-destructive)
 *
 * Safety:
 * - Non-destructive by default. Will not modify external databases or users.
 * - Will not overwrite an existing DATABASE_URL in .env. If DATABASE_URL exists, it will ask to reuse.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const STATE_PATH = path.resolve(process.cwd(), 'installer-state.json');
const ENV_PATH = path.resolve(process.cwd(), '.env');

function runNodeScript(relPath, args = []) {
  const full = path.join('cli', 'installer', relPath);
  console.log('> Running:', 'node', full, ...args);
  const res = spawnSync('node', [full, ...args], { cwd: process.cwd(), stdio: 'inherit', env: process.env });
  return res.status === 0;
}

function stateFromDbManagerSafe() {
  try {
    const sm = require('./state-manager');
    return sm.loadState(STATE_PATH);
  } catch (e) {
    return {};
  }
}
 
// For compatibility in this orchestrator (we avoid direct writes), we still offer a read helper:
function stateManagerLoadSafe() {
  try {
    const sm = require('./state-manager');
    return sm.loadState(STATE_PATH);
  } catch (e) {
    return {};
  }
}
 
const dbm = require('./database-manager');

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const out = {};
  for (const l of lines) {
    const m = l.match(/^\s*([^=]+)\s*=\s*(.*)\s*$/);
    if (m) {
      const key = m[1];
      let val = m[2] || '';
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    }
  }
  return out;
}

/**
 * Deprecated: env writes must go through DatabaseManager.writeEnvDatabaseUrl()
 * Keeping a shim that warns if used.
 */
function writeEnvDatabaseUrl(databaseUrl) {
  console.warn('Warning: install-db attempted to write .env directly. This operation is deprecated; DatabaseManager should handle writes. Forwarding to DatabaseManager.');
  return dbm.writeEnvDatabaseUrl(databaseUrl);
}

function pickBestCandidate(registry, validations) {
  if (!registry || !registry.length) return null;
  // Map validations by source for quick lookup
  const valBySource = {};
  (validations || []).forEach((v) => {
    valBySource[v.source] = v;
  });
  // Candidate scoring:
  // 1) validated psql success & has credentials -> prefer owner != '3x-ui'
  // 2) validated tcp + credentials
  // 3) managed=false preferred over managed=true (we won't modify managed ones)
  const scored = registry.map((r) => {
    const v = valBySource[r.source] || {};
    let score = 0;
    if (r.credentials) score += 20;
    if (v.psql && v.psql.success) score += 50;
    if (v.tcp && v.tcp.ok) score += 10;
    if (r.managed) score -= 5;
    if (r.owner && /3x-?ui|xui/i.test(String(r.owner))) score -= 20;
    return { candidate: r, validation: v, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0] ? scored[0] : null;
}

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve((ans || '').trim());
    });
  });
}

async function main() {
  console.log('=== VPN SaaS adaptive database installer ===');

  // Step 1: Run discovery and validation using centralized DatabaseManager
  const dbm = require('./database-manager');
  console.log('\\nStep 1: discovering databases (DatabaseManager.discover())');
  const disc = await dbm.discover();
  console.log('Discovery complete.');
  console.log('\\nStep 2: validating discovered candidates (DatabaseManager.validate())');
  const val = await dbm.validate({});
  const state = stateFromDbManagerSafe();
  const registry = (state.databases.registrySuggested && state.databases.registrySuggested.databases) || [];
  const validations = (state.databases.validations && state.databases.validations.results) || [];
 
  // Step 3: Check existing .env DATABASE_URL (DatabaseManager will not overwrite .env)
  const envVars = parseEnvFile(ENV_PATH);
  if (envVars.DATABASE_URL) {
    console.log('Found DATABASE_URL in .env. Validating reuse...');
    // Persist selection via DatabaseManager
    await dbm.persist({ type: 'postgres', source: 'env:.env', credentials: { DATABASE_URL: envVars.DATABASE_URL }, managed: false, owner: 'manual' });
    console.log('Saved selection based on existing .env DATABASE_URL. Installer will reuse existing DB settings.');
    console.log('Done.');
    process.exit(0);
  }

  // Step 4: Try to pick a best candidate from registry that is validated
  const best = pickBestCandidate(registry, validations);
  if (best && best.score > 20) {
    const c = best.candidate;
    const v = best.validation;
    console.log('Found a suitable candidate:');
    console.log('  source:', c.source);
    console.log('  host:', c.host, 'port:', c.port, 'database:', c.database, 'owner:', c.owner, 'managed:', c.managed);
    if (c.credentials && (c.credentials.DATABASE_URL || (c.credentials.POSTGRES_USER && c.credentials.POSTGRES_PASSWORD))) {
      // Build DATABASE_URL
      let dbUrl = c.credentials.DATABASE_URL;
      if (!dbUrl) {
        const u = c.credentials.POSTGRES_USER || c.credentials.PGUSER;
        const p = c.credentials.POSTGRES_PASSWORD || c.credentials.PGPASSWORD;
        const db = c.credentials.POSTGRES_DB || c.credentials.PGDATABASE || c.database || 'vpn_saas';
        dbUrl = `postgresql://${encodeURIComponent(u)}:${encodeURIComponent(p)}@${c.host}:${c.port}/${db}`;
      }
      console.log('This candidate contains credentials and passed validation. Will persist selection and write DATABASE_URL to .env if none exists.');
      // Persist selection via DatabaseManager and let it write .env
      await dbm.persist(c);
      const dbUrlToWrite = dbm.generateDatabaseUrl(c) || dbUrl;
      const writeRes = dbm.writeEnvDatabaseUrl(dbUrlToWrite);
      if (writeRes.written) {
        console.log('Database selection persisted to installer-state.json and .env updated.');
      } else {
        console.log('Database selection persisted to installer-state.json. .env already contains DATABASE_URL; not overwritten.');
      }
      process.exit(0);
    } else {
      // Candidate lacks credentials - require user action
      console.log('Candidate lacks discoverable credentials. The installer cannot modify this existing instance.');
      console.log('You can either provide credentials manually or create an isolated Postgres instance for VPN SaaS.');
      const ans = (await prompt('Do you want to (p)rovide credentials, (g)enerate isolated Postgres, or (c)ancel? (p/g/c): ')).toLowerCase();
      if (ans === 'p') {
        console.log('Launching interactive DB decision helper to collect credentials...');
        runNodeScript('db-decision.js');
        // reload selection via DatabaseManager
        const st = stateFromDbManagerSafe();
        if (st.databases && st.databases.selected && st.databases.selected.credentials) {
          const chosen = st.databases.selected;
          const dbUrl = dbm.generateDatabaseUrl(chosen);
          if (dbUrl) {
            const writeRes2 = dbm.writeEnvDatabaseUrl(dbUrl);
            if (writeRes2.written) {
              console.log('Saved manual credentials and wrote DATABASE_URL to .env.');
            } else {
              console.log('Saved manual credentials to installer-state.json. .env already contains DATABASE_URL; not overwritten.');
            }
            process.exit(0);
          } else {
            console.error('Manual credentials were not found in installer-state.json after db-decision. Aborting.');
            process.exit(2);
          }
        } else {
          console.error('No selected database recorded after db-decision. Aborting.');
          process.exit(3);
        }
      } else if (ans === 'g') {
        console.log('Generating isolated Postgres docker-compose (resolve-db --generate-isolated)');
        await dbm.validate({ generateIsolated: true });
        const genCompose = path.join('deploy', 'infrastructure', 'postgres', 'docker-compose.generated.yml');
        console.log(`Compose generated at ${genCompose}.`);
        const startAns = (await prompt('Do you want the installer to start this Postgres container now? (requires docker) (y/N): ')).toLowerCase();
        if (startAns === 'y') {
          console.log('Starting generated Postgres with docker compose...');
          const spawn = spawnSync('docker', ['compose', '-f', genCompose, 'up', '-d'], { stdio: 'inherit' });
          if (spawn.status !== 0) {
            console.error('Failed to start generated Postgres. Please start it manually and re-run this installer step.');
            process.exit(4);
          } else {
            console.log('Started generated Postgres. Re-running validation (DatabaseManager.validate).');
            await dbm.validate({});
            const st2 = stateFromDbManagerSafe();
            const reg = (st2.databases.registrySuggested && st2.databases.registrySuggested.databases) || [];
            const gen = reg.find((r) => r.source && r.source.startsWith('generated:'));
            if (gen && gen.credentials) {
              await dbm.persist(gen);
              const dbUrl = dbm.generateDatabaseUrl(gen);
              if (dbUrl) {
                const wr = dbm.writeEnvDatabaseUrl(dbUrl);
                if (wr.written) {
                  console.log('Isolated Postgres selected and DATABASE_URL written to .env');
                } else {
                  console.log('Isolated Postgres selected and persisted. .env already contains DATABASE_URL; not overwritten.');
                }
                process.exit(0);
              }
            }
            console.error('Generated Postgres was not validated or credentials not found. Please inspect installer-state.json');
            process.exit(5);
          }
        } else {
          console.log('Generated compose was not started. Re-run installer after starting the container and re-run resolve-db.');
          process.exit(0);
        }
      } else {
        console.log('Cancelled by user.');
        process.exit(0);
      }
    }
  }

  // Step 5: No good candidate found - ask user to run db-decision
  console.log('No validated usable candidate was automatically chosen.');
  console.log('Launching interactive DB decision helper (db-decision.js) to let you pick or create a DB.');
  runNodeScript('db-decision.js');
  // After interactive run, refresh state via DatabaseManager and attempt to persist DATABASE_URL if credentials present
  const st3 = stateFromDbManagerSafe();
  if (st3.databases && st3.databases.selected && st3.databases.selected.credentials) {
    const chosen = st3.databases.selected;
    const dbUrl = dbm.generateDatabaseUrl(chosen);
    if (dbUrl) {
      const wr = dbm.writeEnvDatabaseUrl(dbUrl);
      if (wr.written) {
        console.log('Saved selection and wrote DATABASE_URL to .env.');
      } else {
        console.log('Saved selection to installer-state.json. .env already contains DATABASE_URL; not overwritten.');
      }
      process.exit(0);
    } else {
      console.error('db-decision completed but credentials were not stored in installer-state.json. Aborting.');
      process.exit(6);
    }
  } else {
    console.error('db-decision did not record a selection. Aborting.');
    process.exit(7);
  }
}

main().catch((e) => {
  console.error('install-db: unexpected error', e && e.message ? e.message : e);
  process.exit(1);
});