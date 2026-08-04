'use strict';

const { createXuiDetectorRuntime } = require('./xui-detector-runtime');

const XUI_MARKER = /(?:3x-?ui|x-ui|xui|xray.*(?:panel|ui)|inbounds?|login)/i;
const CONFIG_KEYS = new Set(['webPort', 'webDomain', 'webPath', 'webBasePath', 'webCertFile', 'webKeyFile', 'subPort', 'subPath', 'subCertFile', 'version']);
const COMMON_PORTS = [2053, 2052, 8080, 3000];
// Real-world 3x-ui installs keep the panel DB under /etc/x-ui and ship the binary in /usr/local/x-ui.
const XUI_DB_PATHS = ['/etc/x-ui/x-ui.db', '/etc/3x-ui/3x-ui.db', '/usr/local/x-ui/x-ui.db', '/usr/local/x-ui/3x-ui.db', '/opt/3x-ui/3x-ui.db', '/var/lib/3x-ui/3x-ui.db'];
const XUI_BINARIES = ['/usr/local/x-ui/x-ui', '/usr/local/3x-ui/3x-ui'];

function safeError(error) {
  return String(error || 'unknown-error').replace(/postgres(?:ql)?:\/\/[^\s]+/ig, '[REDACTED_URL]').slice(0, 160);
}

function normalizedUrl(value) {
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`);
    return url.toString().replace(/\/$/, '');
  } catch { return null; }
}

function connection(url, webBasePath) {
  const parsed = new URL(url);
  return { url: parsed.toString().replace(/\/$/, ''), scheme: parsed.protocol.slice(0, -1), host: parsed.hostname, port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)), webBasePath: webBasePath || (parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '')) };
}

function parseEnv(text) {
  return Object.fromEntries(String(text || '').split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*?)\s*$/);
    return match ? [[match[1], match[2].replace(/^['"]|['"]$/g, '')]] : [];
  }));
}

function parseDockerPorts(raw) {
  return [...String(raw || '').matchAll(/(?:0\.0\.0\.0|\[::\]|127\.0\.0\.1):(\d+)->\d+\/(?:tcp|udp)/g)].map((match) => Number(match[1]));
}

function scoreProbe(probe) {
  let score = probe.source === 'explicit-url' ? 25 : 0;
  if (probe.statusCode >= 200 && probe.statusCode < 400) score += 35;
  if (probe.statusCode === 401 || probe.statusCode === 403) score += 30;
  if (XUI_MARKER.test(probe.body || '')) score += 35;
  if (/login/i.test(probe.url)) score += 5;
  if (probe.error) score -= 25;
  return Math.max(0, Math.min(100, score));
}

function candidateKey(item) { return `${item.connection.scheme}://${item.connection.host}:${item.connection.port}${item.connection.webBasePath || ''}`; }

function createXuiDetector({ runtime: overrides } = {}) {
  const runtime = createXuiDetectorRuntime(overrides);
  const run = (command, timeout = 5000) => new Promise((resolve) => runtime.exec(command, { timeout, shell: true }, (error, stdout, stderr) => resolve({ ok: !error, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim(), error: error ? safeError(error.message || error) : null })));
  const exists = (file) => { try { return runtime.fs.existsSync(file); } catch { return false; } };
  const diagnostics = [];

  /** Reads settings via sqlite3 CLI, then python3 stdlib, since many 3x-ui hosts ship no sqlite3 binary. */
  async function readSettingsFromDb(file) {
    const cli = await run(`sqlite3 "${file}" "SELECT key, value FROM settings;"`);
    if (cli.ok && cli.stdout) {
      return Object.fromEntries(cli.stdout.split(/\r?\n/).flatMap((line) => { const index = line.indexOf('|'); return index > 0 ? [[line.slice(0, index), line.slice(index + 1)]] : []; }));
    }
    diagnostics.push({ code: 'SQLITE_CLI_UNAVAILABLE', detail: 'sqlite3 CLI missing or failed; trying python3 fallback.' });
    // Read-only URI so detection never mutates the panel database.
    const python = await run(`python3 -c "import sqlite3,json,sys;c=sqlite3.connect('file:${file}?mode=ro',uri=True);print(json.dumps(dict(c.execute('SELECT key, value FROM settings'))))"`);
    if (python.ok && python.stdout.startsWith('{')) { try { return JSON.parse(python.stdout); } catch { /* fall through */ } }
    diagnostics.push({ code: 'SQLITE_PYTHON_UNAVAILABLE', detail: 'python3 sqlite3 fallback failed.' });
    return null;
  }

  /** `x-ui setting -show true` is authoritative and needs no DB reader at all. */
  async function readSettingsFromBinary() {
    for (const binary of XUI_BINARIES) {
      if (!exists(binary)) continue;
      const result = await run(`${binary} setting -show true`, 8000);
      if (!result.ok || !result.stdout) continue;
      const settings = {};
      for (const line of result.stdout.split(/\r?\n/)) {
        const match = line.match(/^\s*(port|webBasePath|webPort|hasDefaultCredential|subPort|subPath)\s*:\s*(.+?)\s*$/i);
        if (match) settings[match[1] === 'port' ? 'webPort' : match[1]] = match[2];
      }
      if (/Panel is secure with SSL/i.test(result.stdout)) settings.webCertFile = settings.webCertFile || 'ssl-enabled';
      if (Object.keys(settings).length) return settings;
    }
    return null;
  }

  async function readSettings(file) {
    try {
      const settings = runtime.readSqliteSettings ? await runtime.readSqliteSettings(file) : (await readSettingsFromDb(file)) || (await readSettingsFromBinary());
      if (!settings) return null;
      const filtered = Object.fromEntries(Object.entries(settings).filter(([key]) => CONFIG_KEYS.has(key)));
      // hasDefaultCredential is not a CONFIG_KEY but drives the credential flow downstream.
      if (settings.hasDefaultCredential !== undefined) filtered.hasDefaultCredential = String(settings.hasDefaultCredential) === 'true';
      return filtered;
    } catch (error) { diagnostics.push({ code: 'SQLITE_READ_FAILED', detail: safeError(error) }); return null; }
  }

  async function discover(options = {}) {
    diagnostics.length = 0;
    const urls = new Map();
    const metadata = [];
    const add = (url, source, webBasePath = '') => {
      const normalized = normalizedUrl(url);
      if (!normalized) { diagnostics.push({ code: 'INVALID_URL', detail: 'A candidate URL was ignored.' }); return; }
      const item = { connection: connection(normalized, webBasePath), source };
      const key = candidateKey(item);
      if (!urls.has(key)) urls.set(key, item);
    };

    if (options.baseUrl) add(options.baseUrl, 'explicit-url');
    const envPaths = ['.env', '.env.example', 'deploy/infrastructure/shared/.env', 'deploy/infrastructure/postgres/.env'].map((file) => runtime.path.resolve(runtime.cwd(), file));
    for (const file of envPaths) if (exists(file)) {
      try {
        const env = parseEnv(runtime.fs.readFileSync(file, 'utf8'));
        for (const key of ['XUI_PANEL_BASE_URL', 'XUI_BASE_URL', 'PANEL_URL']) if (env[key]) add(env[key], `config:${runtime.path.basename(file)}`);
      } catch (error) { diagnostics.push({ code: 'CONFIG_READ_FAILED', detail: safeError(error) }); }
    }

    const docker = await run('docker ps --format "{{.Names}}||{{.Image}}||{{.Ports}}"');
    if (docker.ok) for (const line of docker.stdout.split(/\r?\n/).filter(Boolean)) {
      const [name, image, ports] = line.split('||');
      if (!/xui|3x-ui|xray/i.test(`${name} ${image}`)) continue;
      metadata.push({ source: 'docker', name, image });
      for (const port of parseDockerPorts(ports)) add(`http://127.0.0.1:${port}`, 'docker');
    } else diagnostics.push({ code: 'DOCKER_UNAVAILABLE', detail: 'Docker discovery was unavailable.' });

    const compose = await run('docker compose ps --format "{{.Name}}||{{.Image}}||{{.Publishers}}"');
    if (compose.ok) for (const line of compose.stdout.split(/\r?\n/).filter(Boolean)) {
      const [name, image, ports] = line.split('||');
      if (!/xui|3x-ui|xray/i.test(`${name} ${image}`)) continue;
      metadata.push({ source: 'compose', name, image });
      for (const port of parseDockerPorts(ports)) add(`http://127.0.0.1:${port}`, 'compose');
    }

    const systemd = await run('systemctl list-units --type=service --all --no-legend');
    if (systemd.ok && /(?:3x-ui|x-ui|xui)/i.test(systemd.stdout)) {
      metadata.push({ source: 'systemd' });
      COMMON_PORTS.forEach((port) => add(`http://127.0.0.1:${port}`, 'systemd'));
    }
    const processes = await run(process.platform === 'win32' ? 'tasklist' : 'ps -eo pid,args');
    if (processes.ok && /(?:3x-ui|x-ui|xui)/i.test(processes.stdout)) {
      metadata.push({ source: 'process' });
      COMMON_PORTS.forEach((port) => add(`http://127.0.0.1:${port}`, 'process'));
    }
    const wsl = await run('wsl.exe -e sh -lc "ps -eo args"');
    if (wsl.ok && /(?:3x-ui|x-ui|xui)/i.test(wsl.stdout)) {
      metadata.push({ source: 'wsl' });
      COMMON_PORTS.forEach((port) => add(`http://127.0.0.1:${port}`, 'wsl'));
    }

    // Authoritative local settings: prefer the panel's own DB/binary over port guessing.
    let localSettings = null;
    for (const file of XUI_DB_PATHS) {
      if (!exists(file)) continue;
      const settings = await readSettings(file);
      if (settings && Object.keys(settings).length) { localSettings = settings; break; }
    }
    // The settings table has no hasDefaultCredential column, so always consult the binary too.
    if (!localSettings || localSettings.hasDefaultCredential === undefined) {
      const fromBinary = await readSettingsFromBinary();
      if (fromBinary) {
        const normalized = Object.fromEntries(Object.entries(fromBinary).filter(([key]) => CONFIG_KEYS.has(key)));
        if (fromBinary.hasDefaultCredential !== undefined) normalized.hasDefaultCredential = String(fromBinary.hasDefaultCredential) === 'true';
        // Database values win for file paths; the binary fills in what the table cannot express.
        localSettings = { ...normalized, ...(localSettings || {}), ...(normalized.hasDefaultCredential !== undefined ? { hasDefaultCredential: normalized.hasDefaultCredential } : {}) };
      }
    }
    if (localSettings) {
      metadata.push({ source: 'xui-settings', settings: localSettings });
      // 3x-ui stores the panel prefix as webBasePath; older builds used webPath.
      const rawPath = localSettings.webBasePath || localSettings.webPath || '';
      const webPath = rawPath ? `/${String(rawPath).replace(/^\/+|\/+$/g, '')}` : '';
      const scheme = localSettings.webCertFile ? 'https' : 'http';
      const port = localSettings.webPort || 2053;
      const host = localSettings.webDomain || '127.0.0.1';
      add(`${scheme}://${host}:${port}${webPath}`, 'xui-settings', webPath);
      // The panel binds all interfaces; the public address is what the SaaS must reach.
      if (options.publicHost && options.publicHost !== host) add(`${scheme}://${options.publicHost}:${port}${webPath}`, 'xui-settings', webPath);
    }

    const probes = await Promise.all([...urls.values()].map(async (item) => {
      const base = item.connection.url;
      const webPath = item.connection.webBasePath;
      const root = `${base}${webPath && !base.endsWith(webPath) ? webPath : ''}`;
      // 3x-ui serves the login page at the base path root; /login only accepts POST and 404s on GET.
      const probeUrl = `${root}/`.replace(/([^:]\/)\/+/, '$1');
      const response = await runtime.request(probeUrl, { insecure: !!options.insecure, timeout: options.timeout || 6000 });
      return { ...item, url: probeUrl, statusCode: response.statusCode || 0, body: String(response.body || '').slice(0, 500), error: response.error ? safeError(response.error) : null };
    }));
    const candidates = probes.map((probe) => ({ connection: probe.connection, source: probe.source, confidence: scoreProbe(probe), recognized: XUI_MARKER.test(probe.body) || probe.statusCode === 401 || probe.statusCode === 403, authenticationRequired: probe.statusCode === 401 || probe.statusCode === 403 || /login/i.test(probe.body), version: (probe.body.match(/(?:3x-?ui|x-ui)[^0-9]*(\d+(?:\.\d+)+)/i) || [])[1], diagnostics: probe.error ? [{ code: 'HTTP_ERROR', detail: probe.error }] : [{ code: 'HTTP_STATUS', statusCode: probe.statusCode }] }));
    const best = candidates.sort((a, b) => b.confidence - a.confidence)[0];
    const found = best && best.recognized;
    const settingsMeta = metadata.find((item) => item.source === 'xui-settings');
    return { status: found ? 'FOUND' : candidates.length || metadata.length ? 'PARTIAL' : 'NOT_FOUND', source: best?.source || metadata[0]?.source || 'none', version: best?.version, connection: best?.connection, confidence: best?.confidence || 0, candidates, settings: settingsMeta ? settingsMeta.settings : undefined, hasDefaultCredential: settingsMeta ? settingsMeta.settings.hasDefaultCredential : undefined, diagnostics: [...diagnostics, ...metadata.map((item) => ({ code: 'DISCOVERED_SOURCE', source: item.source }))], observedAt: runtime.now().toISOString(), recommendedAction: found ? 'Select the candidate, then validate credentials separately.' : candidates.length ? 'Review candidate connectivity or provide --base-url.' : 'Install or start XUI, then rerun detection.' };
  }

  /**
   * Authenticates against a discovered candidate and confirms the inbounds API answers.
   * Only a successful API call marks the panel as configured; reachability alone never does.
   */
  async function validate(target = {}, credentials = {}, options = {}) {
    const connectionInfo = target.connection || target;
    if (!connectionInfo || !connectionInfo.url) return { authenticated: false, apiReachable: false, configured: false, diagnostics: [{ code: 'NO_CANDIDATE', detail: 'No connection was supplied to validate.' }] };
    const basePath = connectionInfo.webBasePath && !connectionInfo.url.endsWith(connectionInfo.webBasePath) ? connectionInfo.webBasePath : '';
    const root = `${connectionInfo.url}${basePath}`.replace(/\/$/, '');
    const insecure = !!options.insecure;
    const timeout = options.timeout || 8000;
    const localDiagnostics = [];

    const username = credentials.username || 'admin';
    const password = credentials.password || (target.hasDefaultCredential ? 'admin' : undefined);
    if (!password) return { authenticated: false, apiReachable: false, configured: false, diagnostics: [{ code: 'CREDENTIALS_REQUIRED', detail: 'Panel credentials are required; no default credential was reported.' }] };

    const origin = new URL(root).origin;
    const jar = new Map();
    const collect = (response) => { for (const raw of [].concat(response.headers?.['set-cookie'] || [])) { const [pair] = String(raw).split(';'); const index = pair.indexOf('='); if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim()); } };
    const cookieHeader = () => [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
    const baseHeaders = () => ({ 'X-Requested-With': 'XMLHttpRequest', Origin: origin, Referer: `${root}/`, ...(jar.size ? { Cookie: cookieHeader() } : {}) });

    // The panel rejects unsafe methods with 403 unless they carry a freshly minted CSRF token.
    const csrf = await runtime.request(`${root}/csrf-token`, { method: 'GET', insecure, timeout, headers: baseHeaders() });
    collect(csrf);
    let csrfToken = null;
    try { const payload = JSON.parse(csrf.body || '{}'); if (payload.success === true && typeof payload.obj === 'string') csrfToken = payload.obj; } catch { csrfToken = null; }
    if (!csrfToken) localDiagnostics.push({ code: 'CSRF_TOKEN_UNAVAILABLE', detail: `Could not mint a CSRF token (HTTP ${csrf.statusCode || 0}); login will likely be rejected.` });

    const form = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
    const login = await runtime.request(`${root}/login`, { method: 'POST', body: form, insecure, timeout, headers: { ...baseHeaders(), 'Content-Type': 'application/x-www-form-urlencoded', ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) } });
    collect(login);
    let succeeded = false;
    try { succeeded = JSON.parse(login.body || '{}').success === true; } catch { succeeded = false; }
    if (!succeeded) {
      localDiagnostics.push({ code: 'LOGIN_FAILED', detail: `Panel rejected the credentials (HTTP ${login.statusCode || 0}).` });
      return { authenticated: false, apiReachable: false, configured: false, url: root, diagnostics: localDiagnostics };
    }
    if (!jar.size) localDiagnostics.push({ code: 'NO_SESSION_COOKIE', detail: 'Login succeeded but no session cookie was returned.' });

    const api = await runtime.request(`${root}/panel/api/inbounds/list`, { method: 'GET', insecure, timeout, headers: baseHeaders() });
    let apiOk = false;
    let inbounds = 0;
    try {
      const payload = JSON.parse(api.body || '{}');
      apiOk = payload.success === true;
      inbounds = Array.isArray(payload.obj) ? payload.obj.length : 0;
    } catch { apiOk = false; }
    if (!apiOk) localDiagnostics.push({ code: 'API_UNREACHABLE', detail: `Inbounds API did not return success (HTTP ${api.statusCode || 0}).` });

    return { authenticated: true, apiReachable: apiOk, configured: apiOk, url: root, inbounds, usedDefaultCredential: !credentials.password && !!target.hasDefaultCredential, diagnostics: localDiagnostics, observedAt: runtime.now().toISOString() };
  }

  return { discover, validate };
}

module.exports = { createXuiDetector, parseEnv, scoreProbe };
