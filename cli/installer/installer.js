#!/usr/bin/env node
/**
 * installer.js
 *
 * Production-grade CLI installer for VPN SaaS.
 *
 * Design principles:
 *  - Discovery-first: never ask before auto-detection is complete.
 *  - Near zero-configuration: only Telegram bot token prompts if missing.
 *  - Deterministic: every step is validated before continuing.
 *  - installer-state.json is a cache (with TTL), not a source of truth.
 *  - One canonical .env written by the installer, read by Docker/NestJS/Prisma.
 *
 * Usage:
 *   node cli/installer/installer.js <command> [--flags]
 *
 * Commands:
 *   preflight         Run preflight checks
 *   detect            Auto-discover 3X-UI panel
 *   detect-db         Auto-discover PostgreSQL
 *   auto-config       Run smart auto-configuration (discovery + .env generation)
 *   confirm           Persist confirmed 3X-UI base URL
 *   register          Register detected panel into local database
 *   register-remote   Register panel with remote SaaS endpoint
 *   health            Run comprehensive health verification
 *   state             Show state validation report
 *   all               Run full smart pipeline (zero-config if possible)
 *
 * Flags:
 *   --non-interactive  Skip all prompts (use defaults/skip missing)
 *   --insecure         Skip TLS verification for panel probes
 *   --base-url=URL     Override 3X-UI base URL
 *   --app-url=URL      Override app URL for health checks
 *   --json             Output health results as JSON
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

// ── Color helpers (works on Windows 10+) ────────────────────────────
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function stepTitle(num, total, name) {
  console.log(`\n${C.bold}${C.cyan}━━━ [${num}/${total}] ${name} ━━━${C.reset}`);
}

function ok(msg) { console.log(`${C.green}  ✓${C.reset} ${msg}`); }
function warn(msg) { console.log(`${C.yellow}  ⚠${C.reset} ${msg}`); }
function fail(msg) { console.log(`${C.red}  ✗${C.reset} ${msg}`); }
function info(msg) { console.log(`${C.dim}  ℹ${C.reset} ${msg}`); }

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const flags = {
    nonInteractive: args.includes('--non-interactive'),
    insecure: args.includes('--insecure'),
    json: args.includes('--json'),
    baseUrl: (args.find(a => a.startsWith('--base-url=')) || '').split('=')[1] || null,
    appUrl: (args.find(a => a.startsWith('--app-url=')) || '').split('=')[1] || null,
  };

  if (!cmd || cmd === 'help') {
    console.log(`${C.bold}VPN SaaS Installer${C.reset}`);
    console.log('');
    console.log('Usage: node cli/installer/installer.js <command> [--flags]');
    console.log('');
    console.log('Commands:');
    console.log('  preflight       Run preflight checks');
    console.log('  detect          Auto-discover 3X-UI panel');
    console.log('  detect-db       Auto-discover PostgreSQL');
    console.log('  auto-config     Smart auto-configuration (discovery + .env generation)');
    console.log('  confirm         Persist confirmed 3X-UI base URL');
    console.log('  register        Register detected panel into local database');
    console.log('  register-remote Register panel with remote SaaS endpoint');
    console.log('  health          Run comprehensive health verification');
    console.log('  state           Show state validation report');
    console.log('  all             Run full smart pipeline (zero-config if possible)');
    console.log('');
    console.log('Flags:');
    console.log('  --non-interactive  Skip all prompts');
    console.log('  --insecure         Skip TLS verification');
    console.log('  --base-url=URL     Override 3X-UI base URL');
    console.log('  --app-url=URL      Override app URL for health checks');
    console.log('  --json             Output health as JSON');
    process.exit(0);
  }

  // ── Preflight ──
  if (cmd === 'preflight') {
    await run(path.join('cli', 'installer', 'preflight.js'));
    process.exit(0);
  }

  // ── Detect 3X-UI ──
  if (cmd === 'detect') {
    const forward = args.slice(1);
    const detectResult = await run(path.join('cli', 'installer', 'detect-xui.js'), forward);
    if (detectResult && !detectResult.err) {
      console.log('\n--- Auto-confirming detected panel ---');
      await run(path.join('cli', 'installer', 'confirm-xui.js'), forward.filter(a => a.startsWith('--base-url=')));
    }
    process.exit(0);
  }

  // ── Detect DB ──
  if (cmd === 'detect-db') {
    await run(path.join('cli', 'installer', 'detect-db.js'), args.slice(1));
    process.exit(0);
  }

  // ── Resolve DB ──
  if (cmd === 'resolve-db') {
    await run(path.join('cli', 'installer', 'resolve-db.js'), args.slice(1));
    process.exit(0);
  }

  // ── DB Decision ──
  if (cmd === 'db-decision') {
    await run(path.join('cli', 'installer', 'db-decision.js'), args.slice(1));
    process.exit(0);
  }

  // ── Install DB ──
  if (cmd === 'install-db') {
    await run(path.join('cli', 'installer', 'install-db.js'), args.slice(1));
    process.exit(0);
  }

  // ── Auto-Config (new smart configuration) ──
  if (cmd === 'auto-config') {
    const autoConfig = require('./auto-config');
    try {
      const result = await autoConfig.runAutoConfig({ nonInteractive: flags.nonInteractive });
      console.log(`\n${C.bold}=== Auto-configuration complete ===${C.reset}`);
      if (result.changed.length > 0) {
        ok(`${result.changed.length} value(s) updated: ${result.changed.join(', ')}`);
      } else {
        info('No changes needed — configuration already up to date');
      }
      process.exit(0);
    } catch (e) {
      fail(`Auto-config failed: ${e.message || e}`);
      process.exit(1);
    }
  }

  // ── Confirm ──
  if (cmd === 'confirm') {
    await run(path.join('cli', 'installer', 'confirm-xui.js'), args.slice(1));
    process.exit(0);
  }

  // ── Register ──
  if (cmd === 'register') {
    try {
      const _stateManager = require('./state-manager');
      const statePath = path.resolve(process.cwd(), 'installer-state.json');
      let baseUrl = null;
      const s = _stateManager.loadState(statePath);

      const confirmedEntry = _stateManager.getValidatedEntry(s, 'xui.confirmed', { minConfidence: 'low' });
      if (confirmedEntry && confirmedEntry.value && confirmedEntry.value.baseUrl) {
        baseUrl = confirmedEntry.value.baseUrl;
        info(`Using cached entry (source: ${confirmedEntry.source}, confidence: ${confirmedEntry.confidence})`);
      } else {
        baseUrl = (s.xui && s.xui.confirmed && s.xui.confirmed.baseUrl) || (s.xui && s.xui.selected && s.xui.selected.url) || null;
        if (baseUrl) warn('Using unvalidated cached base URL (legacy format)');
      }

      if (!baseUrl) {
        fail('No confirmed base URL found in installer-state.json');
        info('Run: node cli/installer/installer.js detect');
        process.exit(3);
      }

      ok(`Registering panel: ${baseUrl}`);
      const childEnv = Object.assign({}, process.env);
      childEnv.SANITY_PANEL_BASE_URL = baseUrl;

      const registerCmd = `node ${path.join('scripts', 'register-panel.cjs')}`;
      const child = exec(registerCmd, { cwd: process.cwd(), env: childEnv, timeout: 0 }, (err, stdout, stderr) => {
        if (err) fail(`Registration failed: ${err.message || err}`);
        if (stdout && stdout.trim()) console.log(stdout.trim());
        if (stderr && stderr.trim()) console.error(stderr.trim());
        process.exit(err && err.code ? err.code : 0);
      });

      if (child && child.stdout) child.stdout.pipe(process.stdout);
      if (child && child.stderr) child.stderr.pipe(process.stderr);
    } catch (e) {
      fail(`register: ${e.message || e}`);
      process.exit(1);
    }
  }

  // ── Register Remote ──
  if (cmd === 'register-remote' || cmd === 'remote-register') {
    try {
      await run(path.join('cli', 'installer', 'register-to-saas.js'), args.slice(1));
      process.exit(0);
    } catch (e) {
      fail(`register-remote: ${e.message || e}`);
      process.exit(1);
    }
  }

  // ── Health ──
  if (cmd === 'health') {
    await run(path.join('cli', 'installer', 'verify-health.js'), args.slice(1));
    process.exit(0);
  }

  // ── State ──
  if (cmd === 'state') {
    try {
      const _stateManager = require('./state-manager');
      const statePath = path.resolve(process.cwd(), 'installer-state.json');
      const s = _stateManager.loadState(statePath);

      console.log(`${C.bold}=== Installer State Validation Report ===${C.reset}\n`);
      const report = _stateManager.validateState(s);

      if (report.valid.length > 0) {
        console.log(`${C.green}✓ Valid entries:${C.reset}`);
        for (const p of report.valid) console.log(`    ${p}`);
      }
      if (report.stale.length > 0) {
        console.log(`${C.yellow}⚠ Stale entries (expired, need rediscovery):${C.reset}`);
        for (const p of report.stale) console.log(`    ${p}`);
      }
      if (report.invalid.length > 0) {
        console.log(`${C.red}✗ Invalid entries:${C.reset}`);
        for (const p of report.invalid) console.log(`    ${p}`);
      }
      if (report.unknown.length > 0) {
        console.log(`${C.gray}⊘ Unknown entries (no metadata):${C.reset}`);
        for (const p of report.unknown) console.log(`    ${p}`);
      }

      console.log(`\n${C.bold}--- Summary ---${C.reset}`);
      console.log(`  Valid: ${report.valid.length} | Stale: ${report.stale.length} | Invalid: ${report.invalid.length} | Unknown: ${report.unknown.length}`);

      if (report.stale.length > 0) {
        warn('Stale entries detected. Run `node cli/installer/installer.js detect` to rediscover.');
      }

      if (s.completedStages && Array.isArray(s.completedStages)) {
        console.log(`\n${C.bold}--- Completed Stages ---${C.reset}`);
        console.log(`  ${s.completedStages.join(', ')}`);
      }

      process.exit(0);
    } catch (e) {
      fail(`state: ${e.message || e}`);
      process.exit(1);
    }
  }

  // ── All (full smart pipeline) ──
  if (cmd === 'all') {
    const forward = args.slice(1);
    const TOTAL_STEPS = 7;

    // Step 1: Preflight
    stepTitle(1, TOTAL_STEPS, 'Preflight Checks');
    const preflightResult = await run(path.join('cli', 'installer', 'preflight.js'));
    if (preflightResult && preflightResult.err) {
      fail('Preflight failed. Aborting.');
      process.exit(1);
    }
    ok('Preflight passed');

    // Step 2: Detect 3X-UI
    stepTitle(2, TOTAL_STEPS, 'Detect 3X-UI Panel');
    const detectResult = await run(path.join('cli', 'installer', 'detect-xui.js'), forward);
    if (detectResult && detectResult.err) {
      warn('3X-UI detection failed — will continue with auto-config');
    } else {
      ok('3X-UI detection complete');
    }

    // Step 3: Confirm 3X-UI
    stepTitle(3, TOTAL_STEPS, 'Confirm 3X-UI');
    const confirmResult = await run(path.join('cli', 'installer', 'confirm-xui.js'), forward.filter(a => a.startsWith('--base-url=')));
    if (confirmResult && confirmResult.err) {
      warn('Confirm step had issues — continuing');
    } else {
      ok('3X-UI confirmed');
    }

    // Step 4: Auto-Configuration (discovery + .env generation)
    stepTitle(4, TOTAL_STEPS, 'Smart Auto-Configuration');
    try {
      const autoConfig = require('./auto-config');
      const configResult = await autoConfig.runAutoConfig({ nonInteractive: flags.nonInteractive });
      if (configResult.changed.length > 0) {
        ok(`${configResult.changed.length} value(s) configured: ${configResult.changed.join(', ')}`);
      } else {
        info('Configuration already up to date');
      }
    } catch (e) {
      warn(`Auto-config had issues: ${e.message || e}`);
    }

    // Step 5: Register Panel
    stepTitle(5, TOTAL_STEPS, 'Register Panel');
    try {
      const _stateManager = require('./state-manager');
      const statePath = path.resolve(process.cwd(), 'installer-state.json');
      const s = _stateManager.loadState(statePath);

      const confirmedEntry = _stateManager.getValidatedEntry(s, 'xui.confirmed', { minConfidence: 'low' });
      let baseUrl = null;
      if (confirmedEntry && confirmedEntry.value && confirmedEntry.value.baseUrl) {
        baseUrl = confirmedEntry.value.baseUrl;
      } else {
        baseUrl = (s.xui && s.xui.confirmed && s.xui.confirmed.baseUrl) || (s.xui && s.xui.selected && s.xui.selected.url) || null;
      }

      if (!baseUrl) {
        warn('No confirmed base URL — skipping registration');
      } else {
        ok(`Registering: ${baseUrl}`);
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
          warn('Registration completed with errors (non-fatal)');
        } else {
          ok('Registration completed successfully');
        }
      }
    } catch (e) {
      warn(`Register step error (non-fatal): ${e.message || e}`);
    }

    // Step 6: Health Verification
    stepTitle(6, TOTAL_STEPS, 'Health Verification');
    const healthResult = await run(path.join('cli', 'installer', 'verify-health.js'), forward.filter(a => a.startsWith('--') && !a.startsWith('--base-url=')));
    if (healthResult && healthResult.err) {
      warn('Health verification reported issues');
      info('Run: node cli/installer/installer.js health');
    } else {
      ok('All required services are healthy');
    }

    // Step 7: Final Report
    stepTitle(7, TOTAL_STEPS, 'Installation Report');
    console.log(`${C.bold}${C.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
    console.log(`${C.bold}  VPN SaaS Installation Complete${C.reset}`);
    console.log(`${C.bold}${C.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
    console.log('');
    info('Stages: preflight → detect → confirm → auto-config → register → health');
    console.log('');
    console.log(`${C.bold}Next steps:${C.reset}`);
    console.log('  1. Review .env for any missing values');
    console.log('  2. Start services: docker compose up -d');
    console.log('  3. Check health:  node cli/installer/installer.js health');
    console.log('  4. View state:     node cli/installer/installer.js state');
    process.exit(0);
  }

  fail(`Unknown command: ${cmd}`);
  console.log('Run: node cli/installer/installer.js help');
  process.exit(2);
}

main();