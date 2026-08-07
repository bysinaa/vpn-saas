'use strict';

/**
 * Safe clean-install: removes only Tazaxy-managed resources.
 *
 * Explicitly preserved, always:
 *  - the existing 3X-UI installation, its service and /etc/x-ui/x-ui.db
 *  - PostgreSQL databases other than the Tazaxy one
 *  - Docker containers, networks and volumes not labelled/named for Tazaxy
 *
 * `plan()` is pure and side-effect free so the plan can be shown to the user
 * (and asserted in tests) before anything is touched. `execute()` backs up the
 * .env and installer state first, then performs only the planned actions.
 */

const { createXuiDetectorRuntime } = require('./xui-detector-runtime');

const MANAGED_PATHS = ['/opt/tazaxy', '/usr/local/bin/tazaxy', '/usr/local/bin/vpn-cli', '/etc/systemd/system/tazaxy.service'];
const MANAGED_CONTAINERS = /^(tazaxy[-_]|vpn[-_]?saas[-_])/i;
const MANAGED_NETWORKS = /^(tazaxy[-_]|vpn[-_]?saas[-_])/i;
const MANAGED_VOLUME_LABEL = 'com.tazaxy.managed=true';

/** Anything matching these must never be removed, whatever else is planned. */
const PROTECTED = [
  /\/etc\/x-ui(\/|$)/,
  /\/etc\/3x-ui(\/|$)/,
  /\/usr\/local\/x-ui(\/|$)/,
  /x-ui\.db$/,
  /x-ui\.service$/,
];

function isProtected(target) {
  return PROTECTED.some((pattern) => pattern.test(String(target)));
}

function createCleanInstaller({ runtime: overrides } = {}) {
  const runtime = createXuiDetectorRuntime(overrides);
  const run = (command, timeout = 30000) =>
    new Promise((resolve) =>
      runtime.exec(command, { timeout, shell: true }, (error, stdout, stderr) =>
        resolve({ ok: !error, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() }),
      ),
    );
  const exists = (file) => {
    try {
      return runtime.fs.existsSync(file);
    } catch {
      return false;
    }
  };

  /** Builds the removal plan without touching anything. */
  async function plan(options = {}) {
    const workspace = options.workspace || runtime.cwd();
    const paths = [...new Set([...MANAGED_PATHS, workspace])].filter((file) => exists(file) && !isProtected(file));

    const containerList = await run('docker ps -a --format "{{.Names}}"', 15000);
    const containers = containerList.ok ? containerList.stdout.split(/\r?\n/).filter((name) => name && MANAGED_CONTAINERS.test(name)) : [];

    const networkList = await run('docker network ls --format "{{.Name}}"', 15000);
    const networks = networkList.ok ? networkList.stdout.split(/\r?\n/).filter((name) => name && MANAGED_NETWORKS.test(name)) : [];

    // Volumes are matched by label only: a name-based match risks deleting user data.
    const volumeList = await run(`docker volume ls --filter label=${MANAGED_VOLUME_LABEL} --format "{{.Name}}"`, 15000);
    const volumes = volumeList.ok ? volumeList.stdout.split(/\r?\n/).filter(Boolean) : [];

    const services = [];
    for (const unit of ['tazaxy']) {
      const active = await run(`systemctl is-enabled ${unit} 2>/dev/null`, 10000);
      if (active.ok || active.stdout) services.push(unit);
    }

    return {
      paths,
      containers,
      networks,
      volumes,
      services,
      preserved: {
        xui: ['/etc/x-ui', '/etc/x-ui/x-ui.db', 'x-ui.service', '/usr/local/x-ui'],
        postgres: 'All databases except the Tazaxy application database',
        docker: 'All containers, networks and volumes without a Tazaxy name or label',
      },
    };
  }

  /** Copies .env and installer-state.json somewhere safe before any removal. */
  async function backup(options = {}) {
    const workspace = options.workspace || runtime.cwd();
    const stamp = runtime.now().toISOString().replace(/[:.]/g, '-');
    const target = options.backupDir || `/var/backups/tazaxy/${stamp}`;
    const saved = [];
    try {
      runtime.fs.mkdirSync(target, { recursive: true });
    } catch {
      return { target, saved, ok: false, reason: 'Backup directory could not be created' };
    }
    for (const name of ['.env', 'installer-state.json']) {
      const source = runtime.path.join(workspace, name);
      if (!exists(source)) continue;
      try {
        runtime.fs.copyFileSync(source, runtime.path.join(target, name));
        saved.push(name);
      } catch {
        /* a missing backup must not stop the operator; it is reported below */
      }
    }
    return { target, saved, ok: true };
  }

  /**
   * Performs the plan. `dryRun` reports the exact commands without running
   * them, which is what the regression tests assert against.
   */
  async function execute(options = {}) {
    const removalPlan = options.plan || (await plan(options));
    const backupResult = options.skipBackup ? { skipped: true, saved: [] } : await backup(options);
    const executed = [];
    const failures = [];

    const perform = async (command, description) => {
      if (options.dryRun) {
        executed.push({ command, description, dryRun: true });
        return;
      }
      const outcome = await run(command);
      executed.push({ command, description, ok: outcome.ok });
      if (!outcome.ok) failures.push({ description, detail: outcome.stderr.slice(0, 200) });
    };

    for (const container of removalPlan.containers) await perform(`docker rm -f ${container}`, `Remove container ${container}`);
    for (const volume of removalPlan.volumes) await perform(`docker volume rm ${volume}`, `Remove labelled volume ${volume}`);
    for (const network of removalPlan.networks) await perform(`docker network rm ${network}`, `Remove network ${network}`);
    for (const unit of removalPlan.services) await perform(`systemctl disable --now ${unit}`, `Disable service ${unit}`);
    for (const file of removalPlan.paths) {
      if (isProtected(file)) continue; // second guard: never remove a 3X-UI path
      await perform(`rm -rf "${file}"`, `Remove ${file}`);
    }

    return { plan: removalPlan, backup: backupResult, executed, failures, ok: failures.length === 0 };
  }

  return { plan, backup, execute };
}

module.exports = { createCleanInstaller, isProtected, MANAGED_PATHS, MANAGED_CONTAINERS, MANAGED_VOLUME_LABEL, PROTECTED };
