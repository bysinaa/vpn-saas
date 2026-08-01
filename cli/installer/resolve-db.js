#!/usr/bin/env node
/**
 * resolve-db.js
 *
 * Delegates validation to the centralized DatabaseManager implementation.
 * This wrapper is intentionally thin: DatabaseManager.validate() performs
 * the discovery/validation/generation logic and persists results.
 *
 * Usage:
 *   node cli/installer/resolve-db.js
 *   node cli/installer/resolve-db.js --generate-isolated
 */
const path = require('path');

async function main() {
  try {
    const dbm = require('./database-manager');
    const args = process.argv.slice(2);
    const generateIsolated = args.includes('--generate-isolated');

    console.log('Running database validation via DatabaseManager.validate() ...');
    const res = await dbm.validate({ generateIsolated });

    // DatabaseManager.validate() is expected to update installer-state.json via state module.
    console.log('Validation complete. Summary (from installer-state.json):');

    const statePath = path.resolve(process.cwd(), 'installer-state.json');
    let state = {};
    try {
      const sm = require('./state-manager');
      state = sm.loadState(statePath) || {};
    } catch (e) {
      // best-effort fallback
      try {
        state = require(path.join(process.cwd(), 'installer-state.json'));
      } catch (ee) {
        state = {};
      }
    }

    const validations = (state.databases && state.databases.validations && state.databases.validations.results) || (res && res.validations) || [];
    const suggested = (state.databases && state.databases.registrySuggested && state.databases.registrySuggested.databases) || (res && res.registrySuggested && res.registrySuggested.databases) || [];

    console.log(`  Suggested registry entries: ${suggested.length}`);
    suggested.slice(0, 50).forEach((s, i) => {
      console.log(`   [${i + 1}] host=${s.host} port=${s.port} db=${s.database} owner=${s.owner} managed=${s.managed} creds=${s.credentials ? Object.keys(s.credentials).length : 0} source=${s.source}`);
    });

    console.log(`  Validations: ${validations.length}`);
    validations.slice(0, 50).forEach((v, i) => {
      console.log(`   [${i + 1}] source=${v.source} host=${v.host} port=${v.port} tcp=${v.tcp && v.tcp.ok ? 'OK' : 'FAIL'} psqlAttempted=${v.psql && v.psql.attempted ? 'yes' : 'no'} psqlSuccess=${v.psql && v.psql.success ? 'yes' : 'no'}`);
      if (v.notes && v.notes.length) {
        console.log(`      notes: ${v.notes.slice(0, 4).join(' | ')}`);
      }
    });

    if (generateIsolated) {
      console.log('\n--generate-isolated requested: a generated compose entry should have been created and recorded in installer-state.json as a managed entry.');
      const gen = suggested.find((s) => s.source && String(s.source).startsWith('generated:'));
      if (gen) {
        console.log(`Generated entry found: source=${gen.source} host=${gen.host} port=${gen.port} creds=${gen.credentials ? Object.keys(gen.credentials).length : 0}`);
        console.log('To start the generated Postgres, run:');
        console.log(`  docker compose -f deploy/infrastructure/postgres/docker-compose.generated.yml up -d`);
      } else {
        console.log('No generated entry found in registry. Check installer-state.json for details.');
      }
    }

    console.log('\nNotes: The validation step is non-destructive by default. Existing external databases are not modified.');
    process.exit(0);
  } catch (e) {
    console.error('resolve-db: unexpected error', e && e.message ? e.message : e);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('resolve-db: unexpected error', e && e.message ? e.message : e);
  process.exit(1);
});