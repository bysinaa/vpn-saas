'use strict';

const { createXuiDetectorRuntime } = require('./xui-detector-runtime');

const XUI_MARKER = /(?:3x-?ui|x-ui|xui|xray.*(?:panel|ui)|inbounds?|login)/i;
const CONFIG_KEYS = new Set(['webPort', 'webDomain', 'webPath', 'webCertFile', 'version']);
const COMMON_PORTS = [2053, 2052, 8080, 3000];

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

  async function readSettings(file) {
    try {
      const settings = runtime.readSqliteSettings ? await runtime.readSqliteSettings(file) : await (async () => {
        const result = await run(`sqlite3 "${file}" "SELECT key, value FROM settings;"`);
        if (!result.ok) return null;
        return Object.fromEntries(result.stdout.split(/\r?\n/).flatMap((line) => { const index = line.indexOf('|'); return index > 0 ? [[line.slice(0, index), line.slice(index + 1)]] : []; }));
      })();
      return settings && Object.fromEntries(Object.entries(settings).filter(([key]) => CONFIG_KEYS.has(key)));
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

    const dbPaths = ['/etc/3x-ui/3x-ui.db', '/opt/3x-ui/3x-ui.db', '/var/lib/3x-ui/3x-ui.db', '/usr/local/x-ui/3x-ui.db'];
    for (const file of dbPaths) if (exists(file)) {
      const settings = await readSettings(file);
      if (!settings) continue;
      metadata.push({ source: 'sqlite', settings });
      const webPath = settings.webPath ? `/${String(settings.webPath).replace(/^\/+|\/+$/g, '')}` : '';
      add(`${settings.webCertFile ? 'https' : 'http'}://${settings.webDomain || '127.0.0.1'}:${settings.webPort || 2053}${webPath}`, 'sqlite', webPath);
    }

    const probes = await Promise.all([...urls.values()].map(async (item) => {
      const base = item.connection.url;
      const webPath = item.connection.webBasePath;
      const probeUrl = `${base}${webPath && !base.endsWith(webPath) ? webPath : ''}/login`.replace(/([^:]\/)\/+/, '$1');
      const response = await runtime.request(probeUrl, { insecure: !!options.insecure, timeout: options.timeout || 6000 });
      return { ...item, url: probeUrl, statusCode: response.statusCode || 0, body: String(response.body || '').slice(0, 500), error: response.error ? safeError(response.error) : null };
    }));
    const candidates = probes.map((probe) => ({ connection: probe.connection, source: probe.source, confidence: scoreProbe(probe), recognized: XUI_MARKER.test(probe.body) || probe.statusCode === 401 || probe.statusCode === 403, authenticationRequired: probe.statusCode === 401 || probe.statusCode === 403 || /login/i.test(probe.body), version: (probe.body.match(/(?:3x-?ui|x-ui)[^0-9]*(\d+(?:\.\d+)+)/i) || [])[1], diagnostics: probe.error ? [{ code: 'HTTP_ERROR', detail: probe.error }] : [{ code: 'HTTP_STATUS', statusCode: probe.statusCode }] }));
    const best = candidates.sort((a, b) => b.confidence - a.confidence)[0];
    const found = best && best.recognized;
    return { status: found ? 'FOUND' : candidates.length || metadata.length ? 'PARTIAL' : 'NOT_FOUND', source: best?.source || metadata[0]?.source || 'none', version: best?.version, connection: best?.connection, confidence: best?.confidence || 0, candidates, diagnostics: [...diagnostics, ...metadata.map((item) => ({ code: 'DISCOVERED_SOURCE', source: item.source }))], observedAt: runtime.now().toISOString(), recommendedAction: found ? 'Select the candidate, then validate credentials separately.' : candidates.length ? 'Review candidate connectivity or provide --base-url.' : 'Install or start XUI, then rerun detection.' };
  }
  return { discover };
}

module.exports = { createXuiDetector, parseEnv, scoreProbe };
