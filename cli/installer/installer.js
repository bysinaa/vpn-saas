#!/usr/bin/env node
/**
 * installer.js
 *
 * Small CLI wrapper for installer stages (preflight, detect-xui, confirm-xui, register)
 * Usage:
 *   node cli/installer/installer.js <command> [--flags]
 *
 * Commands:
 *   preflight         Run preflight checks (cli/installer/preflight.js)
 *   detect            Run autodiscovery (cli/installer/detect-xui.js)
 *   detect-db         Run database discovery
 *   resolve-db        Validate discovered db candidates
 *   db-decision       Interactive db decision helper
 *   install-db        Orchestrated adaptive DB installation/selection
 *   confirm [--base-url=...]  Persist confirmed base URL (cli/installer/confirm-xui.js)
 *   register          Register detected panel into local database
 *   register-remote   Register panel with remote SaaS endpoint
 *   health            Run comprehensive health verification (all services)
 *   state             Show state validation report (stale/valid/invalid entries)
 *   all               Run full pipeline: preflight → detect → confirm → register → health
 *
 * This is intentionally lightweight (no external deps) so the installer works with plain node.
 */
const { exec } = require('child_process');
const path = require('path');

function run(nodeScript, args = [], opts = {}) {
  return new Promise((resolve) => {
    const cmd = `node ${nodeScript} ${args.join(' ')}`.trim();
    console.log('Running:', cmd);
    exec(cmd, { cwd: process.cwd(), shell: true, timeout: opts.timeout || 0 }, (err, stdout, stderr) => {
      if (stdout && stdout.trim()) console.log(stdout.trim());
      if (stderr && stderr.trim()) console.error(stderr.trim());
      resolve({ err, stdout: stdout ? stdout.trim() : '', stderr: stderr ? stderr.trim() : '' });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

if (!cmd || cmd === 'help') {
    console.log('installer.js - run installer stages');
    console.log('Usage: node cli/installer/installer.js <command> [--flags]');
    console.log('Commands: preflight | detect | detect-db | resolve-db | db-decision | install-db | confirm [--base-url=URL] | register | register-remote | health | state | all');
    process.exit(0);
  }

  if (cmd === 'preflight') {
    await run(path.join('cli', 'installer', 'preflight.js'));
    process.exit(0);
  }

if (cmd === 'detect') {
    // forward remaining args (e.g. --insecure, --base-url=...)
    const forward = args.slice(1);
    const detectResult = await run(path.join('cli', 'installer', 'detect-xui.js'), forward);
    // Auto-chain confirm if detection succeeded
    if (detectResult && !detectResult.err) {
      console.log('\n--- Auto-confirming detected panel ---');
      await run(path.join('cli', 'installer', 'confirm-xui.js'), forward.filter(a => a.startsWith('--base-url=')));
    }
    process.exit(0);
  }

  if (cmd === 'detect-db') {
    // Run the new database discovery stage (non-destructive)
    const forward = args.slice(1);
    await run(path.join('cli', 'installer', 'detect-db.js'), forward);
    process.exit(0);
  }

  if (cmd === 'resolve-db') {
    // Validate discovered DB candidates and optionally generate an isolated Postgres compose file
    const forward = args.slice(1);
    await run(path.join('cli', 'installer', 'resolve-db.js'), forward);
    process.exit(0);
  }

  if (cmd === 'db-decision') {
    // Interactive DB decision helper (CLI)
    const forward = args.slice(1);
    await run(path.join('cli', 'installer', 'db-decision.js'), forward);
    process.exit(0);
  }

  if (cmd === 'install-db') {
    const forward = args.slice(1);
    await run(path.join('cli', 'installer', 'install-db.js'), forward);
    process.exit(0);
  }

  if (cmd === 'confirm') {
    const forward = args.slice(1); // optional --base-url=...
    await run(path.join('cli', 'installer', 'confirm-xui.js'), forward);
    process.exit(0);
  }

  if (cmd === 'register') {
    // Attempt to register the detected 3x-ui panel into the local database using
    // scripts/register-panel.cjs. The script expects SANITY_PANEL_BASE_URL,
    // SANITY_PANEL_USERNAME and SANITY_PANEL_PASSWORD optionally from env.
    // We'll read installer-state.json to acquire the confirmed base URL and
    // forward it as an environment variable when invoking the script.
    //
    // State validation: before using the cached confirmed URL, validate it.
    // If the entry is stale or missing, signal rediscovery.
    try {
      const _stateManager = require('./state-manager');
      const statePath = path.resolve(process.cwd(), 'installer-state.json');
      let baseUrl = null;
      const s = _stateManager.loadState(statePath);

      // Try validated entry first (xui.confirmed as a structured cache entry)
      const confirmedEntry = _stateManager.getValidatedEntry(s, 'xui.confirmed', { minConfidence: 'low' });
      if (confirmedEntry && confirmedEntry.value && confirmedEntry.value.baseUrl) {
        baseUrl = confirmedEntry.value.baseUrl;
        console.log(`Using validated cached entry (source: ${confirmedEntry.source}, confidence: ${confirmedEntry.confidence}, status: ${confirmedEntry.validationStatus})`);
      } else {
        // Fallback to legacy format (direct baseUrl property)
        baseUrl = (s.xui && s.xui.confirmed && s.xui.confirmed.baseUrl) || (s.xui && s.xui.selected && s.xui.selected.url) || null;
        if (baseUrl) {
          console.log('Warning: using unvalidated cached base URL (legacy format). Consider re-running detect to update state format.');
        }
      }

      if (!baseUrl) {
        console.error('No confirmed base URL found in installer-state.json (or cached entry is stale).');
        console.error('Run: node cli/installer/installer.js detect');
        process.exit(3);
      }

      console.log('Registering panel using base URL:', baseUrl);
      // Build environment for the child process by copying current env and adding SANITY_* vars
      const childEnv = Object.assign({}, process.env);
      childEnv.SANITY_PANEL_BASE_URL = baseUrl;

      // Exec the register script with the modified environment
      const registerCmd = `node ${path.join('scripts', 'register-panel.cjs')}`;
      console.log('Running:', registerCmd);
      const child = exec(registerCmd, { cwd: process.cwd(), env: childEnv, timeout: 0 }, (err, stdout, stderr) => {
        if (err) {
          console.error('Registration failed:', err && err.message ? err.message : err);
        }
        if (stdout && stdout.trim()) console.log(stdout.trim());
        if (stderr && stderr.trim()) console.error(stderr.trim());
        // Exit with child's error code if present
        process.exit(err && err.code ? err.code : 0);
      });

      // Stream output to console in real-time
      if (child && child.stdout) child.stdout.pipe(process.stdout);
      if (child && child.stderr) child.stderr.pipe(process.stderr);
    } catch (e) {
      console.error('register: unexpected error', e && e.message ? e.message : e);
      process.exit(1);
    }
  }

  if (cmd === 'register-remote' || cmd === 'remote-register') {
    // Register the confirmed local panel with a remote SaaS endpoint using
    // cli/installer/register-to-saas.js. Forward any flags such as --saas-url or --insecure.
    try {
      const forward = args.slice(1);
      await run(path.join('cli', 'installer', 'register-to-saas.js'), forward);
      process.exit(0);
    } catch (e) {
      console.error('register-remote: unexpected error', e && e.message ? e.message : e);
      process.exit(1);
    }
  }

  if (cmd === 'all') {
    // Run the full pipeline: preflight → detect → confirm → register
    const forward = args.slice(1);

    console.log('=== Stage 1: Preflight ===');
    const preflightResult = await run(path.join('cli', 'installer', 'preflight.js'));
    if (preflightResult && preflightResult.err) {
      console.error('Preflight failed. Aborting.');
      process.exit(1);
    }

    console.log('\n=== Stage 2: Detect 3X-UI ===');
    const detectResult = await run(path.join('cli', 'installer', 'detect-xui.js'), forward);
    if (detectResult && detectResult.err) {
      console.error('Detection failed. Aborting.');
      process.exit(1);
    }

    console.log('\n=== Stage 3: Confirm 3X-UI ===');
    const confirmResult = await run(path.join('cli', 'installer', 'confirm-xui.js'), forward.filter(a => a.startsWith('--base-url=')));
    if (confirmResult && confirmResult.err) {
      console.error('Confirm failed. Aborting.');
      process.exit(1);
    }

    console.log('\n=== Stage 4: Register Panel ===');
    // Re-invoke the register command logic inline
    try {
      const _stateManager = require('./state-manager');
      const statePath = path.resolve(process.cwd(), 'installer-state.json');
      const s = _stateManager.loadState(statePath);

      // Use validated entry
      const confirmedEntry = _stateManager.getValidatedEntry(s, 'xui.confirmed', { minConfidence: 'low' });
      let baseUrl = null;
      if (confirmedEntry && confirmedEntry.value && confirmedEntry.value.baseUrl) {
        baseUrl = confirmedEntry.value.baseUrl;
      } else {
        baseUrl = (s.xui && s.xui.confirmed && s.xui.confirmed.baseUrl) || (s.xui && s.xui.selected && s.xui.selected.url) || null;
      }

      if (!baseUrl) {
        console.error('No confirmed base URL found. Aborting.');
        process.exit(3);
      }

      console.log('Registering panel using base URL:', baseUrl);
      const childEnv = Object.assign({}, process.env);
      childEnv.SANITY_PANEL_BASE_URL = baseUrl;

      const registerCmd = `node ${path.join('scripts', 'register-panel.cjs')}`;
      const regResult = await new Promise((resolve) => {
        exec(registerCmd, { cwd: process.cwd(), env: childEnv, timeout: 0 }, (err, stdout, stderr) => {
          if (stdout && stdout.trim()) console.log(stdout.trim());
          if (stderr && stderr.trim()) console.error(stderr.trim());
          resolve({ err, code: err && err.code ? err.code : 0 });
        });
      });

      if (regResult.err) {
        console.error('Registration completed with errors (non-fatal for "all" pipeline).');
      } else {
        console.log('Registration completed successfully.');
      }
    } catch (e) {
      console.error('register step: unexpected error (non-fatal)', e && e.message ? e.message : e);
    }

    console.log('\n=== Stage 5: Health Verification ===');
    const healthResult = await run(path.join('cli', 'installer', 'verify-health.js'), forward.filter(a => a.startsWith('--') && !a.startsWith('--base-url=')));
    if (healthResult && healthResult.err) {
      console.error('\n⚠ Health verification reported issues. Installation may not be fully operational.');
      console.error('Run: node cli/installer/installer.js health');
    } else {
      console.log('\n✓ Health verification passed — all required services are working.');
    }

    console.log('\n=== Pipeline complete ===');
    console.log('Stages completed: preflight, detect, confirm, register, health');
    process.exit(0);
  }

  if (cmd === 'health') {
    // Run comprehensive health verification
    const forward = args.slice(1);
    await run(path.join('cli', 'installer', 'verify-health.js'), forward);
    process.exit(0);
  }

  if (cmd === 'state') {
    // Show state validation report
    try {
      const _stateManager = require('./state-manager');
      const statePath = path.resolve(process.cwd(), 'installer-state.json');
      const s = _stateManager.loadState(statePath);

      console.log('=== Installer State Validation Report ===\n');

      const report = _stateManager.validateState(s);

      if (report.valid.length > 0) {
        console.log('✓ Valid entries:');
        for (const p of report.valid) console.log(`    ${p}`);
      }
      if (report.stale.length > 0) {
        console.log('⚠ Stale entries (expired, need rediscovery):');
        for (const p of report.stale) console.log(`    ${p}`);
      }
      if (report.invalid.length > 0) {
        console.log('✗ Invalid entries:');
        for (const p of report.invalid) console.log(`    ${p}`);
      }
      if (report.unknown.length > 0) {
        console.log('⊘ Unknown entries (no metadata):');
        for (const p of report.unknown) console.log(`    ${p}`);
      }

      console.log('\n--- Summary ---');
      console.log(`  Valid: ${report.valid.length} | Stale: ${report.stale.length} | Invalid: ${report.invalid.length} | Unknown: ${report.unknown.length}`);

      if (report.stale.length > 0) {
        console.log('\n⚠ Stale entries detected. Run `node cli/installer/installer.js detect` to rediscover.');
      }

      // Also show completed stages
      if (s.completedStages && Array.isArray(s.completedStages)) {
        console.log('\n--- Completed Stages ---');
        console.log(`  ${s.completedStages.join(', ')}`);
      }

      process.exit(0);
    } catch (e) {
      console.error('state: error reading state:', e && e.message ? e.message : e);
      process.exit(1);
    }
  }

  console.error('Unknown command:', cmd);
  process.exit(2);
}

main();