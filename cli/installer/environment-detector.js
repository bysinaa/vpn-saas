'use strict';

/**
 * Read-only environment detectors used by the automatic installation flow.
 *
 * Every detector returns a `detection-states` result and never throws: a
 * failure is reported as FAILED with a recovery action so that one optional
 * probe can never terminate the installation.
 */

const { createXuiDetectorRuntime } = require('./xui-detector-runtime');
const { createPostgresDetector } = require('./postgres-detector');
const { STATES, result } = require('./detection-states');

const REQUIRED_ENV_KEYS = [
  'APP_URL',
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'ENCRYPTION_KEY',
  'TELEGRAM_BOT_TOKEN',
  'XUI_PANEL_BASE_URL',
];

const CONTAINER_MATCHERS = Object.freeze({
  app: /tazaxy[-_]?app|vpn[-_]?saas[-_]?app/i,
  redis: /redis/i,
  minio: /minio/i,
  postgres: /postgres/i,
});

function parseEnv(text) {
  return Object.fromEntries(
    String(text || '')
      .split(/\r?\n/)
      .flatMap((line) => {
        const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*?)\s*$/);
        return match ? [[match[1], match[2].replace(/^['"]|['"]$/g, '')]] : [];
      }),
  );
}

function safeDetail(value) {
  return String(value || '')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[REDACTED_URL]')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_TOKEN]')
    .slice(0, 200);
}

function createEnvironmentDetector({ runtime: overrides } = {}) {
  const runtime = createXuiDetectorRuntime(overrides);
  const run = (command, timeout = 6000) =>
    new Promise((resolve) =>
      runtime.exec(command, { timeout, shell: true }, (error, stdout, stderr) =>
        resolve({
          ok: !error,
          stdout: String(stdout || '').trim(),
          stderr: String(stderr || '').trim(),
          error: error ? safeDetail(error.message || error) : null,
        }),
      ),
    );
  const exists = (file) => {
    try {
      return runtime.fs.existsSync(file);
    } catch {
      return false;
    }
  };
  const read = (file) => {
    try {
      return runtime.fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  };
  const now = () => runtime.now();

  /** OS family, architecture and whether we can perform privileged work. */
  async function detectSystem() {
    try {
      const osRelease = parseEnv(read('/etc/os-release') || '');
      const arch = await run('uname -m', 4000);
      const kernel = await run('uname -r', 4000);
      const distro = osRelease.ID || osRelease.NAME || 'unknown';
      const family = ['ubuntu', 'debian', 'linuxmint'].includes(distro)
        ? 'debian'
        : ['centos', 'rhel', 'rocky', 'almalinux', 'fedora'].includes(distro)
          ? 'rhel'
          : 'unknown';
      const isRoot = typeof runtime.getuid === 'function' ? runtime.getuid() === 0 : typeof process.getuid === 'function' ? process.getuid() === 0 : false;
      const architecture = arch.stdout || process.arch;
      const data = { distro, version: osRelease.VERSION_ID || 'unknown', family, architecture, kernel: kernel.stdout || 'unknown', isRoot };

      if (!isRoot) {
        return result('system', STATES.NEEDS_CREDENTIALS, {
          now,
          data,
          detail: `${distro} ${architecture} without root privileges`,
          recovery: 'Re-run the installer as root (sudo -i), then retry this step.',
        });
      }
      if (family === 'unknown') {
        return result('system', STATES.DETECTED, {
          now,
          data,
          detail: `${distro} ${architecture} (unvalidated distribution)`,
          recovery: 'Installation continues, but package installation may need manual steps.',
        });
      }
      return result('system', STATES.CONFIGURED, { now, data, detail: `${distro} ${osRelease.VERSION_ID || ''} ${architecture}`.trim() });
    } catch (error) {
      return result('system', STATES.FAILED, { now, detail: safeDetail(error), recovery: 'Inspect /etc/os-release and uname availability.' });
    }
  }

  /** Docker engine plus the Compose v2 plugin, verified by talking to the daemon. */
  async function detectDocker() {
    try {
      const version = await run('docker --version');
      if (!version.ok) {
        return result('docker', STATES.NOT_FOUND, {
          now,
          detail: 'Docker CLI is not installed',
          recovery: 'The installer will install Docker during the infrastructure step.',
        });
      }
      const info = await run('docker info --format "{{.ServerVersion}}"', 10000);
      const compose = await run('docker compose version');
      const data = {
        cli: version.stdout,
        serverVersion: info.ok ? info.stdout : null,
        composeAvailable: compose.ok,
        compose: compose.ok ? compose.stdout : null,
      };
      if (!info.ok) {
        return result('docker', STATES.DETECTED, {
          now,
          data,
          detail: 'Docker CLI present but the daemon did not answer',
          recovery: 'Start the daemon with: systemctl enable --now docker',
        });
      }
      if (!compose.ok) {
        return result('docker', STATES.DETECTED, {
          now,
          data,
          detail: `Docker ${data.serverVersion} running, Compose plugin missing`,
          recovery: 'The installer will install docker-compose-plugin.',
        });
      }
      return result('docker', STATES.CONNECTED, { now, data, detail: `Docker ${data.serverVersion} with ${compose.stdout}` });
    } catch (error) {
      return result('docker', STATES.FAILED, { now, detail: safeDetail(error), recovery: 'Verify the Docker installation manually.' });
    }
  }

  /** An existing Tazaxy deployment: source tree, launcher and generated .env. */
  async function detectExistingInstallation(options = {}) {
    try {
      const installDir = options.installDir || '/opt/tazaxy';
      const workspace = options.workspace || runtime.cwd();
      const roots = [...new Set([installDir, workspace])];
      const found = roots.filter((root) => exists(runtime.path.join(root, 'docker-compose.yml')));
      const launcher = ['/usr/local/bin/tazaxy', '/usr/local/bin/vpn-cli'].filter((file) => exists(file));
      const stateFile = found.map((root) => runtime.path.join(root, 'installer-state.json')).filter(exists);
      const envFiles = found.map((root) => runtime.path.join(root, '.env')).filter(exists);
      const data = { roots: found, launcher, stateFile, envFiles };

      if (found.length === 0 && launcher.length === 0) {
        return result('tazaxy', STATES.NOT_FOUND, { now, data, detail: 'No previous Tazaxy installation was found' });
      }
      if (envFiles.length > 0) {
        return result('tazaxy', STATES.CONFIGURED, { now, data, detail: `Existing installation at ${found[0]} with an .env file` });
      }
      return result('tazaxy', STATES.DETECTED, { now, data, detail: `Partial installation at ${found[0] || launcher[0]}` });
    } catch (error) {
      return result('tazaxy', STATES.FAILED, { now, detail: safeDetail(error), recovery: 'Check filesystem permissions for the install directory.' });
    }
  }

  /** PostgreSQL, delegated to the shared read-only detector. */
  async function detectPostgres(options = {}) {
    try {
      const detection = await createPostgresDetector({ runtime: overrides }).discover(options);
      const data = { connection: detection.connection, source: detection.source, candidates: detection.candidates?.length || 0 };
      if (detection.status === 'FOUND') {
        return result('postgres', STATES.CONNECTED, { now, data, detail: `PostgreSQL accepting connections on ${detection.connection.host}:${detection.connection.port}` });
      }
      if (detection.status === 'PARTIAL') {
        return result('postgres', STATES.DETECTED, {
          now,
          data,
          detail: `PostgreSQL candidate ${detection.connection?.host}:${detection.connection?.port} did not answer a readiness probe`,
          recovery: 'Start PostgreSQL or let the installer provision the bundled container.',
        });
      }
      return result('postgres', STATES.NOT_FOUND, { now, data, detail: 'No PostgreSQL instance found', recovery: 'The installer will provision PostgreSQL.' });
    } catch (error) {
      return result('postgres', STATES.FAILED, { now, optional: true, detail: safeDetail(error), recovery: 'Run "tazaxy infrastructure" to inspect PostgreSQL manually.' });
    }
  }

  /** App, Redis, MinIO and PostgreSQL containers as reported by the daemon. */
  async function detectContainers() {
    try {
      const listing = await run('docker ps --format "{{.Names}}||{{.Image}}||{{.Status}}"');
      if (!listing.ok) {
        return result('containers', STATES.NOT_FOUND, {
          now,
          optional: true,
          data: { app: false, redis: false, minio: false, postgres: false },
          detail: 'Docker did not return a container listing',
          recovery: 'Start Docker, then refresh.',
        });
      }
      const running = { app: false, redis: false, minio: false, postgres: false };
      const names = {};
      for (const line of listing.stdout.split(/\r?\n/).filter(Boolean)) {
        const [name, image] = line.split('||');
        const haystack = `${name} ${image}`;
        for (const [key, matcher] of Object.entries(CONTAINER_MATCHERS)) {
          if (matcher.test(haystack)) {
            running[key] = true;
            names[key] = name;
          }
        }
      }
      const data = { ...running, names };
      const active = Object.values(running).filter(Boolean).length;
      if (running.app && running.redis) {
        return result('containers', STATES.CONNECTED, { now, data, detail: `${active} Tazaxy containers running` });
      }
      if (active > 0) {
        return result('containers', STATES.DETECTED, { now, data, detail: `${active} of 4 containers running`, recovery: 'Start the remaining services from the main menu.' });
      }
      return result('containers', STATES.NOT_FOUND, { now, data, detail: 'No Tazaxy containers are running' });
    } catch (error) {
      return result('containers', STATES.FAILED, { now, optional: true, detail: safeDetail(error), recovery: 'Verify Docker is reachable.' });
    }
  }

  /** The generated .env: present is not enough, the required keys must hold values. */
  async function detectEnvFile(options = {}) {
    try {
      const file = options.envPath || runtime.path.resolve(runtime.cwd(), '.env');
      if (!exists(file)) {
        return result('env', STATES.NOT_FOUND, { now, data: { path: file }, detail: '.env has not been generated yet' });
      }
      const parsed = parseEnv(read(file) || '');
      const missing = REQUIRED_ENV_KEYS.filter((key) => !String(parsed[key] || '').trim());
      const data = { path: file, missing, keys: Object.keys(parsed).length };
      if (missing.length > 0) {
        return result('env', STATES.DETECTED, {
          now,
          data,
          detail: `.env exists but ${missing.length} required value(s) are empty: ${missing.join(', ')}`,
          recovery: 'Re-run environment generation to fill the missing keys.',
        });
      }
      return result('env', STATES.CONFIGURED, { now, data, detail: `.env complete with ${data.keys} keys` });
    } catch (error) {
      return result('env', STATES.FAILED, { now, detail: safeDetail(error), recovery: 'Check read permissions on the .env file.' });
    }
  }

  return { detectSystem, detectDocker, detectExistingInstallation, detectPostgres, detectContainers, detectEnvFile };
}

module.exports = { createEnvironmentDetector, parseEnv, REQUIRED_ENV_KEYS };
