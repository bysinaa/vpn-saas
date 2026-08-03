#!/usr/bin/env node
/**
 * db-decision.js
 *
 * Interactive DB decision helper for the installer.
 * This version delegates all discovery/validation/persistence to the centralized
 * DatabaseManager (cli/installer/database-manager.js -> src/database/database-manager.js).
 *
 * Responsibilities (delegated):
 *  - Present discovered PostgreSQL instances (from installer-state.json).
 *  - Let operator choose reuse / generate isolated / provide credentials.
 *  - Persist final choice via DatabaseManager.persist()
 *
 * Safety rules:
 *  - Non-destructive by default. Creating an isolated instance only writes compose file; it does NOT start containers.
 *  - Never resets/changes credentials for discovered instances.
 *
 * Usage:
 *   node cli/installer/db-decision.js
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const readline = require('readline');

const STATE_PATH = path.resolve(process.cwd(), 'installer-state.json');
const dbm = require('./database-manager');
const stateManager = require('./state-manager');

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || '').trim());
    });
  });
}

function listRegistry(registry) {
  if (!registry || !registry.length) {
    console.log('No registry entries found.');
    return;
  }
  console.log('Discovered PostgreSQL candidates:');
  registry.forEach((r, i) => {
    console.log(`  [${i + 1}] host=${r.host} port=${r.port} db=${r.database} owner=${r.owner} managed=${r.managed} source=${r.source} creds=${r.credentials ? Object.keys(r.credentials).length : 0}`);
  });
}

function runResolveDbValidate() {
  // run resolve-db.js non-interactively to refresh validations
  const res = spawnSync('node', [path.join('cli', 'installer', 'resolve-db.js')], { cwd: process.cwd(), stdio: 'inherit', env: process.env });
  return res.status === 0;
}

async function main() {
  console.log('DB Decision helper: this tool will help you pick or create a PostgreSQL instance for TAZAXY.');

  // Load state via CLI state-manager
  let state = {};
  try {
    state = stateManager.loadState(STATE_PATH) || {};
  } catch (e) {
    console.warn('Warning: failed to load installer-state.json via state-manager:', e && e.message ? e.message : e);
    state = {};
  }

  const registry = (state.databases && state.databases.registrySuggested && state.databases.registrySuggested.databases) || [];
  if (!registry.length) {
    console.log('No discovered registry entries were found. You can either generate an isolated Postgres or provide manual credentials.');
  } else {
    listRegistry(registry);
  }

  console.log('\\nOptions:');
  console.log('  1) Reuse an existing detected PostgreSQL instance');
  console.log('  2) Create an isolated Postgres (generate docker-compose file only; you must run it manually)');
  console.log('  3) Provide manual credentials (DATABASE_URL or user/password)');
  const opt = await prompt('Choose an option (1/2/3): ');

  if (opt === '1') {
    if (!registry.length) {
      console.log('No candidates to reuse. Choose option 2 or 3 instead.');
      process.exit(2);
    }
    const sel = await prompt(`Enter number of candidate to reuse (1-${registry.length}): `);
    const idx = parseInt(sel, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= registry.length) {
      console.error('Invalid selection.');
      process.exit(3);
    }
    const chosen = registry[idx];
    console.log('You selected:', chosen);

    if (!chosen.credentials || Object.keys(chosen.credentials).length === 0) {
      console.log('Warning: the selected instance has no discovered credentials. The installer will NOT modify this instance. You must provide credentials manually or choose to create an isolated Postgres.');
      const c = await prompt('Do you want to (a) provide credentials now, (b) generate an isolated Postgres, or (c) cancel? (a/b/c): ');
      if (c === 'a') {
        const dbUrl = await prompt('Enter DATABASE_URL (leave empty to provide user/password instead): ');
        if (dbUrl) {
          const entry = { type: 'postgres', host: chosen.host, port: chosen.port, database: chosen.database || 'tazaxy', owner: chosen.owner || 'unknown', managed: false, source: `manual:provided-dburl`, credentials: { DATABASE_URL: dbUrl } };
          await dbm.persist(entry);
          console.log('Saved manual DATABASE_URL to installer-state.json as selected database.');
          console.log('Validating selection using DatabaseManager.validate()...');
          await dbm.validate({ registry: [entry], generateIsolated: false });
          process.exit(0);
        } else {
          const user = await prompt('POSTGRES_USER: ');
          const pass = await prompt('POSTGRES_PASSWORD: ');
          const db = await prompt('POSTGRES_DB (default tazaxy): ');
          if (!user || !pass) {
            console.error('Incomplete credentials provided.');
            process.exit(4);
          }
          const entry = { type: 'postgres', host: chosen.host, port: chosen.port, database: db || 'tazaxy', owner: chosen.owner || 'unknown', managed: false, source: `manual:provided-userpass`, credentials: { POSTGRES_USER: user, POSTGRES_PASSWORD: pass, POSTGRES_DB: db || 'tazaxy' } };
          await dbm.persist(entry);
          console.log('Saved manual credentials to installer-state.json as selected database.');
          console.log('Validating selection using DatabaseManager.validate()...');
          await dbm.validate({ registry: [entry], generateIsolated: false });
          process.exit(0);
        }
      } else if (c === 'b') {
        console.log('Generating isolated Postgres (compose file only)...');
        await dbm.validate({ registry: null, generateIsolated: true });
        console.log('Compose generated. Follow instructions from resolve-db output to start container and re-run this helper.');
        process.exit(0);
      } else {
        console.log('Cancelled.');
        process.exit(0);
      }
    } else {
      // credentials present - persist selection and validate
      await dbm.persist(chosen);
      console.log('Saved selected candidate to installer-state.json as selected database. Validating now...');
      await dbm.validate({ registry: [chosen], generateIsolated: false });
      process.exit(0);
    }
  } else if (opt === '2') {
    console.log('Generating isolated Postgres (compose file only)...');
    await dbm.validate({ registry: null, generateIsolated: true });
    console.log('Compose generated. Follow instructions from resolve-db output to start container and re-run this helper.');
    process.exit(0);
  } else if (opt === '3') {
    const dbUrl = await prompt('Enter DATABASE_URL (leave empty to provide user/password instead): ');
    if (dbUrl) {
      const entry = { type: 'postgres', host: null, port: null, database: null, owner: 'manual', managed: false, source: `manual:provided-dburl`, credentials: { DATABASE_URL: dbUrl } };
      await dbm.persist(entry);
      console.log('Saved manual DATABASE_URL to installer-state.json as selected database. Validating now...');
      await dbm.validate({ registry: [entry], generateIsolated: false });
      process.exit(0);
    } else {
      const host = await prompt('Host (default localhost): ');
      const port = await prompt('Port (default 5432): ');
      const user = await prompt('POSTGRES_USER: ');
      const pass = await prompt('POSTGRES_PASSWORD: ');
      const db = await prompt('POSTGRES_DB (default tazaxy): ');
      if (!user || !pass) {
        console.error('Incomplete credentials provided.');
        process.exit(7);
      }
      const entry = { type: 'postgres', host: host || 'localhost', port: port ? parseInt(port, 10) : 5432, database: db || 'tazaxy', owner: 'manual', managed: false, source: `manual:provided-userpass`, credentials: { POSTGRES_USER: user, POSTGRES_PASSWORD: pass, POSTGRES_DB: db || 'tazaxy' } };
      await dbm.persist(entry);
      console.log('Saved manual credentials to installer-state.json as selected database. Validating now...');
      await dbm.validate({ registry: [entry], generateIsolated: false });
      process.exit(0);
    }
  } else {
    console.error('Unknown option. Exiting.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('db-decision: unexpected error', e && e.message ? e.message : e);
  process.exit(1);
});