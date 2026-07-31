#!/usr/bin/env node
/**
 * Improved Preflight checks script for vpn-saas installer.
 *
 * Improvements:
 *  - Provides remediation guidance for common failures (missing tools, permissions).
 *  - Does not treat lack of sudo as fatal (only warns) to support running from non-root environments where possible.
 *  - Better Windows detection and graceful fallback for platform-specific commands.
 *  - Produces structured state including remediation actions and per-check guidance.
 *
 * Usage:
 *   node cli/installer/preflight.js
 *
 * Output:
 *   - installer-state.json in current working directory
 *
 * Note:
 *  This is an iterative scaffold. The CLI installer will call this during Stage 1.
 */
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_PATH = path.resolve(process.cwd(), 'installer-state.json');
const _stateManager = require('./state-manager');

function runCmd(cmd, opts = {}) {
  const timeout = opts.timeout || 15_000;
  return new Promise((resolve) => {
    exec(cmd, { timeout, shell: true }, (err, stdout, stderr) => {
      resolve({
        command: cmd,
        success: !err,
        code: err && err.code != null ? err.code : 0,
        stdout: stdout ? stdout.trim() : '',
        stderr: stderr ? stderr.trim() : '',
      });
    });
  });
}

async function checkOSAndPrivileges(result) {
  result.os = {};
  result.os.platform = process.platform;
  if (process.platform === 'win32') {
    // Limited checks for Windows - we don't require full Linux toolchain here.
    result.os.note = 'Detected Windows; preflight will run limited checks.';
    result.os.info = await runCmd('ver', { timeout: 3000 });
  } else {
    result.os.uname = await runCmd('uname -a', { timeout: 5000 });
    result.os.lsb_release = await runCmd('lsb_release -a', { timeout: 5000 });
    try {
      const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
      result.os.os_release = { success: true, stdout: osRelease };
    } catch (e) {
      result.os.os_release = { success: false, stderr: String(e) };
    }
  }

  // privileges
  result.privileges = {};
  try {
    result.privileges.uid = process.getuid ? process.getuid() : null;
    result.privileges.isRoot = result.privileges.uid === 0;
  } catch (e) {
    result.privileges.uid = null;
    result.privileges.isRoot = false;
  }

  // Check sudo availability if not root (non-fatal)
  result.privileges.sudoCheck = null;
  if (!result.privileges.isRoot && process.platform !== 'win32') {
    const sudo = await runCmd('sudo -n true', { timeout: 3000 });
    result.privileges.sudoAvailable = sudo.success;
    result.privileges.sudoCheck = sudo;
  }
}

async function checkResources(result) {
  result.resources = {};
  // CPU cores
  try {
    result.resources.cpus = os.cpus().length;
  } catch (e) {
    result.resources.cpus = null;
  }
  // memory
  try {
    result.resources.totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
  } catch (e) {
    result.resources.totalMemMB = null;
  }
  // disk free on root (best-effort: different command on Windows)
  if (process.platform === 'win32') {
    result.resources.df = await runCmd('wmic logicaldisk get size,freespace,caption', { timeout: 5000 });
  } else {
    result.resources.df = await runCmd('df -h /', { timeout: 5000 });
    result.resources.nproc = await runCmd('nproc', { timeout: 2000 });
    result.resources.free = await runCmd('free -m', { timeout: 3000 });
  }
}

async function checkNetworkAndTime(result) {
  result.network = {};
  if (process.platform === 'win32') {
    result.network.ping = await runCmd('ping -n 3 8.8.8.8', { timeout: 8000 });
    result.network.curlGithub = await runCmd('curl -I --connect-timeout 5 https://github.com', { timeout: 10_000 });
    result.network.timedate = await runCmd('powershell -Command "Get-Date"', { timeout: 3000 });
    result.network.nslookup = await runCmd('nslookup example.com', { timeout: 5000 });
  } else {
    result.network.ping = await runCmd('ping -c 3 8.8.8.8', { timeout: 8000 });
    result.network.curlGithub = await runCmd('curl -I --connect-timeout 5 https://github.com', { timeout: 10_000 });
    result.network.timedatectl = await runCmd('timedatectl status', { timeout: 3000 });
    result.network.nslookup = await runCmd('nslookup example.com', { timeout: 5000 });
  }
}

async function checkRequiredTools(result) {
  result.tools = {};
  // Acceptable fallbacks:
  // - docker compose plugin or classic docker-compose
  // - openssl optional (warn)
  const cmds = {
    docker: 'docker --version',
    'docker_compose': 'docker compose version || docker-compose --version',
    git: 'git --version',
    curl: 'curl --version',
    openssl: 'openssl version',
    node: 'node --version',
    npm: 'npm --version',
  };

  for (const [k, c] of Object.entries(cmds)) {
    result.tools[k] = await runCmd(c, { timeout: 5000 });
  }
}

async function checkPorts(result) {
  result.ports = {};
  if (process.platform === 'win32') {
    result.ports.netstat = await runCmd('netstat -ano', { timeout: 5000 });
  } else {
    const ss = await runCmd('ss -tulpn', { timeout: 5000 });
    if (ss.success) {
      result.ports.ss = ss;
    } else {
      result.ports.netstat = await runCmd('netstat -tulpn', { timeout: 5000 });
    }
  }
  // docker ps (may fail if docker missing)
  result.ports.docker_ps = await runCmd('docker ps --format "{{.Names}} {{.Image}} {{.Ports}}"', { timeout: 5000 });
}

async function detectExistingInstallations(result) {
  result.existing = {};
  // Best-effort: these commands may return empty on Windows
  result.existing.vpn_saas = await runCmd(process.platform === 'win32' ? 'tasklist | findstr /I vpn-saas || true' : 'ps aux | grep -i "vpn-saas" | grep -v grep || true', { timeout: 3000 });
  result.existing.docker_containers = await runCmd('docker ps --format "{{.Names}} {{.Image}} {{.Ports}}"', { timeout: 5000 });
  // look for container names containing xui or 3x
  try {
    const grepXui = await runCmd('docker ps --format "{{.Names}} {{.Image}} {{.Ports}}" | grep -Ei "xui|3x" || true', { timeout: 3000 });
    result.existing.possible_xui_containers = grepXui;
  } catch (e) {
    result.existing.possible_xui_containers = { success: false, stderr: String(e) };
  }
  // Check common install paths
  const candidates = ['/opt/3x-ui', '/opt/xui', '/usr/local/bin/3x-ui', '/etc/3x-ui', '/var/lib/3x-ui'];
  result.existing.paths = {};
  for (const p of candidates) {
    try {
      result.existing.paths[p] = fs.existsSync(p);
    } catch (e) {
      result.existing.paths[p] = false;
    }
  }
}

function evaluateResults(state) {
  state.summary = { fatal: false, warnings: [], remediation: [] };

  // OS detection
  if (process.platform !== 'win32') {
    if (!state.os.os_release || !state.os.os_release.success) {
      state.summary.warnings.push('Could not fully determine Linux distribution from /etc/os-release.');
      state.summary.remediation.push('Ensure /etc/os-release exists or provide OS info manually to installer.');
    }
  } else {
    state.summary.warnings.push('Windows detected: some installer checks are limited on Windows.');
    state.summary.remediation.push('Prefer a Linux host for production installs. Windows support is limited.');
  }

  // Privileges: warn but do not fatal
  if (!state.privileges.isRoot && !state.privileges.sudoAvailable) {
    state.summary.warnings.push('No root and sudo not available. Some operations may require manual intervention.');
    state.summary.remediation.push('Run the installer as root or ensure the user has sudo privileges.');
  } else if (!state.privileges.isRoot && state.privileges.sudoAvailable) {
    state.summary.remediation.push('Sudo available: installer will attempt to use sudo for privileged operations when needed.');
  }

  // Resources
  const cpus = state.resources.nproc && state.resources.nproc.success ? parseInt(state.resources.nproc.stdout.split('\n')[0], 10) : state.resources.cpus;
  const mem = state.resources.totalMemMB;
  if (cpus != null && cpus < 2) {
    state.summary.warnings.push(`CPUs low: ${cpus} (recommended >=2)`);
    state.summary.remediation.push('For production, provision a machine with at least 2 vCPUs.');
  }
  if (mem != null && mem < 4000) {
    state.summary.warnings.push(`Memory low: ${mem}MB (recommended >=4GB)`);
    state.summary.remediation.push('Increase RAM or move components to separate hosts.');
  }

  // Tools: docker and compose are fatal if missing (installer cannot proceed)
  const neededFatal = ['docker', 'docker_compose'];
  for (const t of neededFatal) {
    if (!state.tools[t] || !state.tools[t].success) {
      state.summary.fatal = true;
      state.summary.warnings.push(`Required tool missing: ${t}`);
      state.summary.remediation.push(`Install ${t}. Example (Ubuntu): sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin`);
    }
  }

  // Openssl: optional but recommended
  if (!state.tools.openssl || !state.tools.openssl.success) {
    state.summary.warnings.push('openssl is missing or not found. TLS/SSL diagnostics will be limited.');
    state.summary.remediation.push('Install openssl (e.g., sudo apt-get install -y openssl).');
  }

  // If we detected possible 3x-ui containers, ask to run detect-xui next
  if (state.existing.possible_xui_containers && state.existing.possible_xui_containers.stdout && state.existing.possible_xui_containers.stdout.trim() !== '') {
    state.summary.warnings.push('Possible 3x-ui containers found. Run detect-xui to gather details.');
    state.summary.remediation.push('Run: node cli/installer/detect-xui.js  (coming in next iteration)');
  }

  return state;
}

async function main() {
  console.log('Preflight checks starting — this may take a few seconds...');
  const state = {
    installerVersion: '0.2',
    date: new Date().toISOString(),
    completedStages: [],
    checks: {},
  };

  try {
    await checkOSAndPrivileges(state.checks);
    state.completedStages.push('os_privileges');

    await checkResources(state.checks);
    state.completedStages.push('resources');

    await checkNetworkAndTime(state.checks);
    state.completedStages.push('network_time');

    await checkRequiredTools(state.checks);
    state.completedStages.push('required_tools');

    await checkPorts(state.checks);
    state.completedStages.push('ports_scan');

    await detectExistingInstallations(state.checks);
    state.completedStages.push('existing_detection');

    // Evaluate
    const evaluated = evaluateResults(state.checks);
    state.summary = evaluated.summary;

    // Save state file
    try {
      _stateManager.saveState(STATE_PATH, state);
      console.log('Preflight state written to', STATE_PATH);
    } catch (e) {
      console.error('Failed to write state file:', e);
    }

    // Print summary to console
    console.log('=== Preflight summary ===');
    console.log('Fatal:', state.summary.fatal);
    if (state.summary.warnings && state.summary.warnings.length) {
      console.log('Warnings:');
      state.summary.warnings.forEach((w) => console.log(' -', w));
    } else {
      console.log('No warnings detected.');
    }

    if (state.summary.remediation && state.summary.remediation.length) {
      console.log('\nRemediation suggestions:');
      state.summary.remediation.forEach((r, i) => console.log(` ${i + 1}. ${r}`));
    }

    if (state.summary.fatal) {
      console.error('One or more fatal preflight errors detected. Fix them and run this script again.');
      process.exit(20);
    }

    console.log('Preflight checks completed successfully (with possible warnings).');
    process.exit(0);
    } catch (err) {
      console.error('Unexpected error during preflight:', err);
      try {
        _stateManager.saveState(STATE_PATH, { error: String(err), date: new Date().toISOString() });
      } catch (e) {
        // ignore
      }
      process.exit(30);
    }
}

main();