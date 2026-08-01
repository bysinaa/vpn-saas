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
 *   register          Placeholder: register panel with SaaS backend (not implemented)
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
    console.log('Commands: preflight | detect | detect-db | resolve-db | db-decision | install-db | confirm [--base-url=URL] | register');
    process.exit(0);
  }

  if (cmd === 'preflight') {
    await run(path.join('cli', 'installer', 'preflight.js'));
    process.exit(0);
  }

if (cmd === 'detect') {
    // forward remaining args (e.g. --insecure, --base-url=...)
    const forward = args.slice(1);
    await run(path.join('cli', 'installer', 'detect-xui.js'), forward);
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
    try {
      const _stateManager = require('./state-manager');
      const statePath = path.resolve(process.cwd(), 'installer-state.json');
      let baseUrl = null;
      const s = _stateManager.loadState(statePath);
      baseUrl = (s.xui && s.xui.confirmed && s.xui.confirmed.baseUrl) || (s.xui && s.xui.selected && s.xui.selected.url) || null;

      if (!baseUrl) {
        console.error('No confirmed base URL found in installer-state.json. Run detect and confirm first, or pass --base-url to confirm.');
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

  console.error('Unknown command:', cmd);
  process.exit(2);
}

main();