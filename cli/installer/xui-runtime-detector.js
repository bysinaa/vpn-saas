'use strict';

/**
 * Discovers the runtime configuration of an *already installed* 3X-UI panel and
 * reports it as an explicit state.
 *
 * This module never installs a panel, never changes a port and never asks the
 * user for TLS, port or base path: those are read from the panel itself in this
 * priority order.
 *
 *   1. `x-ui setting -show true`      - authoritative, needs no SQLite reader
 *   2. `/etc/x-ui/x-ui.db` settings   - sqlite3 CLI, then a python3 fallback
 *   3. `x-ui.service` unit file       - install directory and binary
 *   4. listening sockets              - confirms the port is actually bound
 *
 * Only `authenticate()` may return CONNECTED, and only after a real login plus
 * an authorized API call. Discovery alone can never exceed DETECTED.
 */

const { createXuiDetectorRuntime } = require('./xui-detector-runtime');
const { createXuiDetector } = require('./xui-detector');
const { STATES, result } = require('./detection-states');

const DB_PATHS = ['/etc/x-ui/x-ui.db', '/etc/3x-ui/3x-ui.db', '/usr/local/x-ui/x-ui.db', '/opt/3x-ui/3x-ui.db'];
const BINARIES = ['/usr/local/x-ui/x-ui', '/usr/local/3x-ui/3x-ui', '/usr/bin/x-ui'];
const SERVICE_FILES = ['/etc/systemd/system/x-ui.service', '/etc/systemd/system/3x-ui.service', '/usr/lib/systemd/system/x-ui.service'];

function safeDetail(value) {
  return String(value || 'unknown-error')
    .replace(/password[^\s&]*/gi, 'password=[REDACTED]')
    .slice(0, 200);
}

function normalizeBasePath(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '/') return '';
  return `/${raw.replace(/^\/+|\/+$/g, '')}/`;
}

function createXuiRuntimeDetector({ runtime: overrides } = {}) {
  const runtime = createXuiDetectorRuntime(overrides);
  const run = (command, timeout = 8000) =>
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
  const read = (file) => {
    try {
      return runtime.fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  };
  const now = () => runtime.now();

  /** systemd unit: proves the panel is installed and points at its binary. */
  async function readService() {
    const active = await run('systemctl is-active x-ui 2>/dev/null || systemctl is-active 3x-ui 2>/dev/null', 6000);
    const unitFile = SERVICE_FILES.find(exists);
    const unit = unitFile ? read(unitFile) : null;
    const execStart = unit ? (unit.match(/^ExecStart=(.+)$/m) || [])[1] : null;
    const workingDirectory = unit ? (unit.match(/^WorkingDirectory=(.+)$/m) || [])[1] : null;
    return {
      present: Boolean(unitFile) || active.stdout === 'active',
      active: active.stdout === 'active',
      unitFile: unitFile || null,
      execStart: execStart ? execStart.trim() : null,
      workingDirectory: workingDirectory ? workingDirectory.trim() : null,
    };
  }

  /** `x-ui setting -show true` is the most reliable source and needs no DB reader. */
  async function readBinarySettings() {
    for (const binary of BINARIES) {
      if (!exists(binary)) continue;
      const output = await run(`${binary} setting -show true`, 10000);
      if (!output.ok || !output.stdout) continue;
      const settings = {};
      for (const line of output.stdout.split(/\r?\n/)) {
        const match = line.match(/^\s*(port|webPort|webBasePath|webCertFile|webKeyFile|subPort|subPath|subURI|subEnable|hasDefaultCredential|username)\s*:\s*(.*?)\s*$/i);
        if (!match) continue;
        const key = match[1] === 'port' ? 'webPort' : match[1];
        settings[key] = match[2];
      }
      if (/Panel is secure with SSL/i.test(output.stdout)) settings.tlsHint = true;
      if (Object.keys(settings).length > 0) return { source: `binary:${binary}`, settings, binary };
    }
    return null;
  }

  /**
   * Reads the panel settings table read-only. Many 3x-ui hosts ship no sqlite3
   * CLI at all, so the python3 stdlib fallback is usually the one that runs.
   */
  async function readDatabaseSettings() {
    for (const file of DB_PATHS) {
      if (!exists(file)) continue;
      const cli = await run(`sqlite3 "${file}" "SELECT key, value FROM settings;"`);
      if (cli.ok && cli.stdout) {
        const settings = Object.fromEntries(
          cli.stdout.split(/\r?\n/).flatMap((line) => {
            const index = line.indexOf('|');
            return index > 0 ? [[line.slice(0, index), line.slice(index + 1)]] : [];
          }),
        );
        if (Object.keys(settings).length > 0) return { source: `sqlite3:${file}`, settings, dbPath: file };
      }
      const python = await run(
        `python3 -c "import sqlite3,json;c=sqlite3.connect('file:${file}?mode=ro',uri=True);print(json.dumps(dict(c.execute('SELECT key, value FROM settings'))))"`,
        10000,
      );
      if (python.ok && python.stdout.startsWith('{')) {
        try {
          return { source: `python3:${file}`, settings: JSON.parse(python.stdout), dbPath: file };
        } catch {
          /* fall through to the next candidate */
        }
      }
    }
    return null;
  }

  /** Reads the stored admin username; the password hash is never returned. */
  async function readStoredUsername(dbPath) {
    if (!dbPath || !exists(dbPath)) return null;
    const cli = await run(`sqlite3 "${dbPath}" "SELECT username FROM users LIMIT 1;"`);
    if (cli.ok && cli.stdout) return cli.stdout.split(/\r?\n/)[0].trim() || null;
    const python = await run(
      `python3 -c "import sqlite3;c=sqlite3.connect('file:${dbPath}?mode=ro',uri=True);r=c.execute('SELECT username FROM users LIMIT 1').fetchone();print(r[0] if r else '')"`,
      10000,
    );
    return python.ok && python.stdout ? python.stdout.trim() || null : null;
  }

  /** Confirms the discovered port is genuinely bound, so we never re-map it. */
  async function readListeningPorts() {
    const output = await run('ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null', 6000);
    if (!output.ok || !output.stdout) return { ports: [], xuiPorts: [] };
    const ports = new Set();
    const xuiPorts = new Set();
    for (const line of output.stdout.split(/\r?\n/)) {
      const match = line.match(/[:.](\d{2,5})\s+[\d.:*\[\]]+\s/);
      if (!match) continue;
      const port = Number(match[1]);
      ports.add(port);
      if (/x-ui|3x-ui|xray/i.test(line)) xuiPorts.add(port);
    }
    return { ports: [...ports].sort((a, b) => a - b), xuiPorts: [...xuiPorts].sort((a, b) => a - b) };
  }

  /**
   * Full read-only discovery. Returns DETECTED when a panel is found (never
   * CONFIGURED/CONNECTED — that requires authentication), NEEDS_CREDENTIALS
   * when a panel exists but no username could be read.
   */
  async function discover(options = {}) {
    try {
      const service = await readService();
      const binary = await readBinarySettings();
      const database = await readDatabaseSettings();
      const listening = await readListeningPorts();

      // Binary output wins over the settings table: it reflects the running process.
      const settings = { ...(database?.settings || {}), ...(binary?.settings || {}) };
      const sources = [service.present ? 'systemd' : null, binary?.source, database?.source, listening.xuiPorts.length ? 'listening-ports' : null].filter(Boolean);

      if (!service.present && !binary && !database) {
        return result('xui', STATES.NOT_FOUND, {
          now,
          data: { sources, listening },
          detail: 'No existing 3X-UI installation was detected',
          recovery: 'Install 3X-UI first, or run "tazaxy install-3xui".',
        });
      }

      const webPort = Number(settings.webPort || settings.port || 0) || null;
      const basePath = normalizeBasePath(settings.webBasePath || settings.webPath || '');
      const tlsEnabled = Boolean(settings.webCertFile || settings.tlsHint || settings.webKeyFile);
      const host = options.publicHost || settings.webDomain || '127.0.0.1';
      const scheme = tlsEnabled ? 'https' : 'http';
      const subPort = Number(settings.subPort || 0) || null;
      const subPath = settings.subPath ? `/${String(settings.subPath).replace(/^\/+|\/+$/g, '')}/` : '/sub/';
      const dbPath = database?.dbPath || DB_PATHS.find(exists) || null;
      const username = settings.username || (await readStoredUsername(dbPath));
      const portBound = webPort ? listening.ports.includes(webPort) : false;

      const data = {
        service,
        dbPath,
        webPort,
        basePath,
        tlsEnabled,
        subPort,
        subPath,
        subEnable: settings.subEnable === undefined ? undefined : String(settings.subEnable) === 'true',
        host,
        username: username || null,
        hasDefaultCredential: settings.hasDefaultCredential === undefined ? undefined : String(settings.hasDefaultCredential) === 'true',
        portBound,
        listening,
        sources,
        url: webPort ? `${scheme}://${host}:${webPort}${basePath}` : null,
      };

      if (!webPort) {
        return result('xui', STATES.DETECTED, {
          now,
          data,
          detail: '3X-UI is installed but its web port could not be read',
          recovery: 'Run "x-ui settings" on the host, then retry detection.',
        });
      }
      if (!username) {
        return result('xui', STATES.NEEDS_CREDENTIALS, {
          now,
          data,
          detail: `3X-UI reachable at ${data.url} but no stored username could be read`,
          recovery: 'Enter the panel username and password when prompted; nothing else is required.',
        });
      }
      return result('xui', STATES.DETECTED, {
        now,
        data,
        detail: `3X-UI at ${data.url} (TLS ${tlsEnabled ? 'on' : 'off'}, sub port ${subPort || 'n/a'})`,
        recovery: 'Authenticate to promote this panel to CONNECTED.',
      });
    } catch (error) {
      return result('xui', STATES.FAILED, { now, detail: safeDetail(error), recovery: 'Check that /etc/x-ui is readable and retry detection.' });
    }
  }

  /**
   * Promotes a discovered panel to CONNECTED. Delegates to the shared detector,
   * which handles the CSRF token, the session cookie and the panel's habit of
   * answering a failed login with HTTP 200 + {"success":false}.
   */
  async function authenticate(detection, credentials = {}, options = {}) {
    const data = detection?.data || {};
    if (!data.url) {
      return result('xui', STATES.NOT_FOUND, { now, detail: 'No discovered panel URL to authenticate against', recovery: 'Run detection first.' });
    }
    const username = credentials.username || data.username;
    const password = credentials.password;
    if (!username || !password) {
      return result('xui', STATES.NEEDS_CREDENTIALS, {
        now,
        data,
        detail: 'Panel credentials are required to verify the connection',
        recovery: 'Provide the 3X-UI username and password.',
      });
    }

    try {
      const detector = createXuiDetector({ runtime: overrides });
      const connection = { url: data.url, webBasePath: '' };
      // TLS on a panel with a self-signed certificate is normal; allow it explicitly.
      const insecure = options.insecure !== undefined ? options.insecure : data.tlsEnabled === true;
      const validation = await detector.validate({ connection }, { username, password }, { insecure, timeout: options.timeout || 10000 });

      if (!validation.authenticated) {
        return result('xui', STATES.NEEDS_CREDENTIALS, {
          now,
          data,
          diagnostics: validation.diagnostics,
          detail: 'The panel rejected the supplied credentials',
          recovery: 'Re-enter the 3X-UI username and password.',
        });
      }
      if (!validation.apiReachable) {
        return result('xui', STATES.FAILED, {
          now,
          data,
          diagnostics: validation.diagnostics,
          detail: 'Login succeeded but the inbounds API did not answer',
          recovery: 'Verify the panel account has API access, then retry.',
        });
      }
      return result('xui', STATES.CONNECTED, {
        now,
        data: { ...data, username, inbounds: validation.inbounds, verifiedAt: now().toISOString() },
        detail: `Authenticated at ${data.url} (${validation.inbounds} inbound(s))`,
      });
    } catch (error) {
      return result('xui', STATES.FAILED, { now, data, detail: safeDetail(error), recovery: 'Check panel connectivity and TLS settings, then retry.' });
    }
  }

  return { discover, authenticate, readService, readBinarySettings, readDatabaseSettings, readListeningPorts, readStoredUsername };
}

module.exports = { createXuiRuntimeDetector, normalizeBasePath, DB_PATHS, BINARIES, SERVICE_FILES };
