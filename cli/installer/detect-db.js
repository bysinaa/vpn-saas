#!/usr/bin/env node
/**
 * detect-db.js
 *
 * Wrapper that delegates non-destructive discovery to the shared DatabaseManager
 * implementation (src/database/database-manager.js). Keeps CLI compatibility while
 * ensuring there is a single authoritative implementation of discovery logic.
 *
 * Usage:
 *   node cli/installer/detect-db.js
 */
const path = require('path');

async function main() {
  try {
    const dbm = require('./database-manager');
    console.log('Database discovery (delegated to DatabaseManager.discover())...');
    const res = await dbm.discover();
    console.log('Discovery completed. Summary:');
    const discovered = (res && res.discovered) || (res && res.state && res.state.databases && res.state.databases.discovered) || [];
    const suggested = (res && res.registrySuggested && res.registrySuggested.databases) || (res && res.state && res.state.databases && res.state.databases.registrySuggested && res.state.databases.registrySuggested.databases) || [];
    console.log(`  Discovered candidates: ${discovered.length}`);
    discovered.slice(0, 50).forEach((d, i) => {
      console.log(`   [${i + 1}] source=${d.source} type=${d.type} host=${d.host} port=${d.port} container=${d.container || ''}`);
    });
    console.log(`  Registry suggested entries: ${suggested.length}`);
    suggested.slice(0, 50).forEach((s, i) => {
      console.log(`   [${i + 1}] host=${s.host} port=${s.port} db=${s.database} owner=${s.owner} managed=${s.managed} creds=${s.credentials ? Object.keys(s.credentials).length : 0} source=${s.source}`);
    });
    console.log('\\nNotes (top 20):');
    const notes = (res && res.state && res.state.databases && res.state.databases.notes) || (res && res.state && res.state.databases && res.state.databases.notes) || (res && res.notes) || [];
    (notes || []).slice(0, 20).forEach((n, i) => {
      console.log(`  - ${n.type || 'note'}: ${n.path || n.name || JSON.stringify(n).slice(0, 120)}`);
    });
    console.log('\\nInstaller state has been updated (installer-state.json) by DatabaseManager.discover() where possible.');
    process.exit(0);
  } catch (e) {
    console.error('detect-db: unexpected error', e && e.message ? e.message : e);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('detect-db: unexpected error', e && e.message ? e.message : e);
  process.exit(1);
});