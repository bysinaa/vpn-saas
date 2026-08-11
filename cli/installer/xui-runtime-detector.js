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

// 3x-ui's built-in subscription port. Panels that never changed it store no
// `subPort` row at all, so the value has to be inferred from bound sockets.
const DEFAULT_SUB_PORT = 2096;

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

function listenerRows(text) {
  return String(text || '').split(/\r?\n/).flatMap((line) => {
    const match = line.match(/(?:\[?[^\s\]]+\]?|\*):([0-9]{1,5})\s/);
    if (!match) return [];
    const process = (line.match(/users:\(\(\"([^\"]+)/) || [])[1] || null;
    return [{ protocol: /\budp\b/i.test(line) ? 'udp' : 'tcp', port: Number(match[1]), owner: process, raw: line }];
  });
}

function dockerPorts(text) {
  return [...String(text || '').matchAll(/(?:0\.0\.0\.0|\[::\]|127\.0\.0\.1):(\d+)->(\d+)\/(?:tcp|udp)/g)].map((match) => ({ hostPort: Number(match[1]), containerPort: Number(match[2]) }));
}

function safeDsn(value) {
  try { const url = new URL(value); return { host: url.hostname, port: Number(url.port || 5432), database: url.pathname.replace(/^\//, '') || null }; } catch { return null; }
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
    const dbType = unit ? (unit.match(/\bXUI_DB_TYPE=(sqlite|postgres)\b/i) || [])[1]?.toLowerCase() : null;
    const dsn = unit ? (unit.match(/\bXUI_DB_DSN=([^\s"']+)/i) || [])[1] : null;
    return {
      present: Boolean(unitFile) || active.stdout === 'active',
      active: active.stdout === 'active',
      unitFile: unitFile || null,
      execStart: execStart ? execStart.trim() : null,
      workingDirectory: workingDirectory ? workingDirectory.trim() : null,
      database: { backend: dbType || null, dsn: safeDsn(dsn) },
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
        const match = line.match(/^\s*(port|webPort|webBasePath|webDomain|webCertFile|webKeyFile|subPort|subPath|subURI|subDomain|subCertFile|subKeyFile|subEnable|hasDefaultCredential|username)\s*:\s*(.*?)\s*$/i);
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
    const output = await run('ss -ltnp 2>/dev/null; ss -lunp 2>/dev/null || netstat -ltnp 2>/dev/null', 6000);
    const listeners = listenerRows(output.stdout);
    const ports = [...new Set(listeners.map((item) => item.port))].sort((a, b) => a - b);
    const xuiPorts = [...new Set(listeners.filter((item) => /x-ui|3x-ui|xray/i.test(item.owner || item.raw)).map((item) => item.port))].sort((a, b) => a - b);
    return { ports, xuiPorts, listeners };
  }

  async function readDocker() {
    const output = await run('docker ps --format "{{.Names}}||{{.Image}}||{{.Ports}}"', 6000);
    const line = output.stdout.split(/\r?\n/).find((item) => /(?:3x-ui|x-ui)/i.test(item));
    if (!line) return null;
    const [name, image, ports] = line.split('||');
    const mappings = dockerPorts(ports);
    return { name, image, mappings, panelPort: mappings.find((item) => item.containerPort === 2053)?.hostPort || null, subscriptionPort: mappings.find((item) => item.containerPort === 2096)?.hostPort || null };
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
      const docker = await readDocker();

      // Binary output wins over the settings table: it reflects the running process.
      const settings = { ...(database?.settings || {}), ...(binary?.settings || {}) };
      const sources = [service.present ? 'systemd' : null, binary?.source, database?.source, listening.xuiPorts.length ? 'listening-ports' : null].filter(Boolean);

      if (!service.present && !binary && !database && !docker) {
        return result('xui', STATES.NOT_FOUND, {
          now,
          data: { status: 'NOT_FOUND', installation: { kind: 'unknown' }, panel: null, subscription: null, authentication: { state: 'AUTH_REQUIRED', credentialsAvailable: false }, database: { backend: 'unknown', path: null, dsn: null }, listeners: listening.listeners, diagnostics: [{ code: 'XUI_NOT_FOUND' }] },
          diagnostics: [{ code: 'XUI_NOT_FOUND' }],
          detail: 'No existing 3X-UI installation was detected',
          recovery: 'Install 3X-UI first, or run "tazaxy install-3xui".',
        });
      }

      const webPort = Number(settings.webPort || settings.port || docker?.panelPort || 0) || null;
      const basePath = normalizeBasePath(settings.webBasePath || settings.webPath || '');
      const tlsEnabled = Boolean(settings.webCertFile || settings.tlsHint || settings.webKeyFile);
      const host = settings.webDomain || options.publicHost || '127.0.0.1';
      const scheme = tlsEnabled ? 'https' : 'http';
      // A panel left on the stock subscription port stores no `subPort` row, so
      // treat a bound 2096 as the effective value rather than reporting "n/a".
      const declaredSubPort = Number(settings.subPort || docker?.subscriptionPort || 0) || null;
      const subPortBound = listening.ports.includes(DEFAULT_SUB_PORT);
      const subPort = declaredSubPort || (subPortBound ? DEFAULT_SUB_PORT : null);
      const subPortSource = declaredSubPort ? 'settings' : subPortBound ? 'default-bound' : 'unknown';
      const subPath = settings.subPath ? `/${String(settings.subPath).replace(/^\/+|\/+$/g, '')}/` : '/sub/';
      const subHost = settings.subDomain || host;
      const subTlsEnabled = Boolean(settings.subCertFile || settings.subKeyFile);

      const dbPath = database?.dbPath || DB_PATHS.find(exists) || null;
      const username = settings.username || (await readStoredUsername(dbPath));
      const portBound = webPort ? listening.ports.includes(webPort) : false;

      const panelOwner = webPort ? listening.listeners.find((item) => item.protocol === 'tcp' && item.port === webPort)?.owner : null;
      const subscriptionOwner = subPort ? listening.listeners.find((item) => item.protocol === 'tcp' && item.port === subPort)?.owner : null;
      const diagnostics = [];
      if (!webPort) diagnostics.push({ code: 'PANEL_PORT_UNKNOWN' });
      else if (!portBound) diagnostics.push({ code: 'PANEL_PORT_NOT_LISTENING', port: webPort });
      else if (panelOwner && !/x-ui|3x-ui|xray/i.test(panelOwner)) diagnostics.push({ code: 'PORT_OWNED_BY_DIFFERENT_PROCESS', port: webPort, owner: panelOwner });
      if (subPort && !listening.ports.includes(subPort)) diagnostics.push({ code: 'SUBSCRIPTION_PORT_NOT_LISTENING', port: subPort });
      else if (subscriptionOwner && !/x-ui|3x-ui|xray/i.test(subscriptionOwner)) diagnostics.push({ code: 'PORT_OWNED_BY_DIFFERENT_PROCESS', port: subPort, owner: subscriptionOwner });
      if (!username) diagnostics.push({ code: 'AUTH_REQUIRED' });
      const panelUrl = webPort ? `${scheme}://${host}:${webPort}${basePath}` : null;
      const data = {
        status: 'DISCOVERED',
        installation: { kind: docker ? 'docker' : service.present || binary || database ? 'native' : 'unknown', service, binary: binary?.binary || null, docker, version: settings.version || null },
        panel: { scheme, host, port: webPort, webBasePath: basePath, tls: { enabled: tlsEnabled, certFile: settings.webCertFile || null, keyFile: settings.webKeyFile || null }, url: panelUrl, listening: portBound, owner: panelOwner },
        subscription: { scheme: subTlsEnabled ? 'https' : 'http', host: subHost, port: subPort, path: subPath, enabled: settings.subEnable === undefined ? subPortBound || undefined : String(settings.subEnable) === 'true', portSource: subPortSource, tls: { enabled: subTlsEnabled, certFile: settings.subCertFile || null, keyFile: settings.subKeyFile || null }, listening: Boolean(subPort && listening.ports.includes(subPort)), owner: subscriptionOwner },
        authentication: { state: 'AUTH_REQUIRED', username: username || null, credentialsAvailable: false, hasDefaultCredential: settings.hasDefaultCredential === undefined ? undefined : String(settings.hasDefaultCredential) === 'true' },
        database: { backend: service.database.backend || (database ? 'sqlite' : 'unknown'), path: dbPath, dsn: service.database.dsn, source: database?.source || null },
        listeners: listening.listeners.map(({ raw, ...listener }) => listener),
        diagnostics,
      };

      if (!webPort) {
        return result('xui', STATES.DETECTED, {
          now,
          data, diagnostics,
          detail: '3X-UI is installed but its web port could not be read',
          recovery: 'Run "x-ui settings" on the host, then retry detection.',
        });
      }
      return result('xui', STATES.DETECTED, {
        now,
        data, diagnostics,
        detail: `3X-UI at ${data.panel.url} (TLS ${tlsEnabled ? 'on' : 'off'}, sub port ${subPort || 'n/a'})`,
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
    if (!data.panel?.url) {
      return result('xui', STATES.NOT_FOUND, { now, detail: 'No discovered panel URL to authenticate against', recovery: 'Run detection first.' });
    }
    const username = credentials.username || data.authentication?.username;
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
      const connection = { url: data.panel.url };
      // TLS on a panel with a self-signed certificate is normal; allow it explicitly.
      const insecure = options.insecure !== undefined ? options.insecure : data.panel.tls.enabled === true;
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
        data: { ...data, authentication: { ...data.authentication, state: 'AUTHENTICATED', username }, inbounds: validation.inbounds, verifiedAt: now().toISOString() },
        detail: `Authenticated at ${data.panel.url} (${validation.inbounds} inbound(s))`,
      });
    } catch (error) {
      return result('xui', STATES.FAILED, { now, data, detail: safeDetail(error), recovery: 'Check panel connectivity and TLS settings, then retry.' });
    }
  }

  return { discover, authenticate, readService, readBinarySettings, readDatabaseSettings, readListeningPorts, readDocker, readStoredUsername };
}

module.exports = { createXuiRuntimeDetector, normalizeBasePath, DB_PATHS, BINARIES, SERVICE_FILES };
