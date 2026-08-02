#!/usr/bin/env node
/**
 * detect-xui.js
 *
 * Purpose:
 *  - Autodiscover an existing 3x-ui installation on the host.
 *  - Detect installation method: docker/container, systemd/service, or host files.
 *  - Gather published ports, container IPs, mounted volumes, and candidate base URLs.
 *  - Read 3x-ui SQLite config DB for webPort, webDomain, webPath, webCertFile.
 *  - Read .env files for existing XUI_PANEL_URL / SANITY_PANEL_BASE_URL.
 *  - Perform HTTP checks using Node.js built-in http/https (cross-platform, no curl needed).
 *  - Append findings to installer-state.json (created by preflight).
 *
 * Usage:
 *   node cli/installer/detect-xui.js [--base-url=http://...] [--insecure] [--username=admin --password=...]
 *
 * Notes:
 *  - Best-effort; non-destructive.
 *  - Uses docker CLI and systemctl where available.
 *  - Cross-platform: works on Windows (cmd.exe) and Linux (bash/sh).
 *  - Uses Node.js http/https for probing instead of curl for TLS compatibility.
 */
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const STATE_PATH = path.resolve(process.cwd(), 'installer-state.json');

const IS_WIN = process.platform === 'win32';

/**
 * Run a shell command. On Windows, avoid `|| true` which doesn't work in cmd.exe.
 * Instead, we catch errors in the callback and return a normalized result.
 */
function runCmd(cmd, opts = {}) {
  const timeout = opts.timeout || 10_000;
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

/**
 * HTTP/HTTPS probe using Node.js built-in modules.
 * Returns { statusCode, headers, body, ok, error }.
 * Handles TLS errors gracefully (especially on Windows with self-signed certs).
 */
function httpProbe(urlString, opts = {}) {
  const insecure = !!opts.insecure;
  const method = opts.method || 'GET';
  const timeout = opts.timeout || 7000;

  return new Promise((resolve) => {
    let urlObj;
    try {
      urlObj = new URL(urlString);
    } catch (e) {
      resolve({ ok: false, error: 'invalid-url', statusCode: 0, headers: {}, body: '' });
      return;
    }

    const isHttps = urlObj.protocol === 'https:';
    const client = isHttps ? https : http;

    const reqOpts = {
      method,
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + (urlObj.search || ''),
      headers: { 'User-Agent': 'vpn-saas-installer/1.0', Accept: 'text/html,application/json,*/*' },
      timeout,
      rejectUnauthorized: !insecure,
    };

    // For HTTPS with insecure mode, create a custom agent
    if (isHttps && insecure) {
      reqOpts.agent = new https.Agent({ rejectUnauthorized: false });
    }

    const req = client.request(reqOpts, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 500,
          statusCode: res.statusCode,
          headers: res.headers || {},
          body: body || '',
          error: null,
        });
      });
    });

    req.on('error', (err) => {
      resolve({ ok: false, error: err.message || String(err), statusCode: 0, headers: {}, body: '' });
    });

    req.on('timeout', () => {
      req.destroy(new Error('request-timeout'));
    });

    req.end();
  });
}

const _stateManager = require('./state-manager');
const loadState = () => _stateManager.loadState(STATE_PATH);
const saveState = (s) => _stateManager.saveState(STATE_PATH, s);

const CLI = (function parseArgs() {
  const out = { baseUrl: null, insecure: false, username: null, password: null };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--base-url=')) {
      out.baseUrl = a.split('=')[1];
    } else if (a === '--insecure') {
      out.insecure = true;
    } else if (a.startsWith('--username=')) {
      out.username = a.split('=')[1];
    } else if (a.startsWith('--password=')) {
      out.password = a.split('=')[1];
    }
  }
  return out;
})();

// ── Discovery helpers ──────────────────────────────────────────────

/**
 * Parse .env file content into a key-value object.
 */
function parseEnvFile(content) {
  const out = {};
  if (!content) return out;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    let value = trimmed.substring(eqIdx + 1).trim();
    // Remove surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Read .env files and extract panel-related URLs.
 */
function discoverFromEnvFiles() {
  const results = [];
  const envPaths = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '.env.example'),
    path.resolve(process.cwd(), 'deploy', 'infrastructure', 'shared', '.env'),
    path.resolve(process.cwd(), 'deploy', 'infrastructure', 'postgres', '.env'),
  ];

  const keys = ['XUI_PANEL_URL', 'SANITY_PANEL_BASE_URL', 'XUI_BASE_URL', 'PANEL_URL'];

  for (const envPath of envPaths) {
    try {
      if (!fs.existsSync(envPath)) continue;
      const content = fs.readFileSync(envPath, 'utf8');
      const env = parseEnvFile(content);
      for (const key of keys) {
        if (env[key]) {
          results.push({ source: `envfile:${envPath}`, key, url: env[key] });
        }
      }
    } catch (e) {
      // non-fatal
    }
  }
  return results;
}

/**
 * Detect Docker containers that look like 3x-ui.
 */
async function detectDockerContainers() {
  const out = [];
  // Use docker ps with format — no `|| true` needed, we handle errors in runCmd
  const dockerPs = await runCmd('docker ps --format "{{.Names}}||{{.Image}}||{{.Ports}}"', { timeout: 5000 });
  if (!dockerPs.success || !dockerPs.stdout) return out;
  const lines = dockerPs.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const l of lines) {
    if (/xui|3x|x-ui|xray|xray-panel|xui-panel/i.test(l)) {
      const parts = l.split('||');
      out.push({
        raw: l,
        name: parts[0] || '',
        image: parts[1] || '',
        portsRaw: parts[2] || '',
      });
    }
  }
  return out;
}

/**
 * Inspect a Docker container for published ports, IP, mounts, and env vars.
 */
async function inspectContainer(name) {
  const inspect = await runCmd(`docker inspect ${name} --format "{{json .}}"`, { timeout: 5000 });
  if (!inspect.success || !inspect.stdout) return null;
  try {
    const obj = JSON.parse(inspect.stdout);
    const networkSettings = obj.NetworkSettings || {};
    const ports = networkSettings.Ports || {};
    const published = [];
    for (const [containerPort, mapping] of Object.entries(ports)) {
      if (mapping && Array.isArray(mapping)) {
        mapping.forEach((m) => {
          published.push({ containerPort, hostIp: m.HostIp, hostPort: m.HostPort });
        });
      }
    }
    const containerIP = Object.values(networkSettings.Networks || {})[0]?.IPAddress || null;
    const mounts = (obj.Mounts || []).map((m) => ({ Source: m.Source, Destination: m.Destination, Mode: m.RW ? 'rw' : 'ro' }));

    // Extract env vars that might contain panel config
    const envVars = {};
    const configEnv = obj.Config?.Env || [];
    for (const e of configEnv) {
      const eqIdx = e.indexOf('=');
      if (eqIdx > 0) {
        const key = e.substring(0, eqIdx);
        const value = e.substring(eqIdx + 1);
        // Only capture relevant env vars
        if (/XUI|PANEL|3X|XRAY|SUB/i.test(key)) {
          envVars[key] = value;
        }
      }
    }

    return { published, containerIP, mounts, image: obj.Config?.Image || '', envVars };
  } catch (e) {
    return { error: 'inspect-parse-failed', raw: inspect.stdout.substring(0, 500) };
  }
}

/**
 * Detect systemd services for 3x-ui.
 */
async function detectSystemdService() {
  const candidates = ['3x-ui', 'xui', 'x-ui', 'xray-ui', 'xray-panel'];
  const found = [];
  for (const s of candidates) {
    const st = await runCmd(`systemctl status ${s}`, { timeout: 3000 });
    if (st.success && st.stdout && !/could not be found|not-found/i.test(st.stdout)) {
      found.push({ service: s, statusRaw: st.stdout.substring(0, 500) });
    }
  }
  return found;
}

/**
 * Read 3x-ui SQLite config database for webPort, webDomain, webPath, webCertFile.
 */
async function readXuiConfigDb(dbPath) {
  const settingsResult = await runCmd(
    `sqlite3 "${dbPath}" "SELECT key, value FROM settings;"`,
    { timeout: 5000 }
  );

  if (!settingsResult.success || !settingsResult.stdout) return null;

  const settings = {};
  for (const line of settingsResult.stdout.split('\n')) {
    const sepIdx = line.indexOf('|');
    if (sepIdx > 0) {
      const key = line.substring(0, sepIdx).trim();
      const value = line.substring(sepIdx + 1).trim();
      settings[key] = value;
    }
  }
  return settings;
}

// ── Probe helpers ──────────────────────────────────────────────────

/**
 * Build probe URLs from a base URL, optionally with a webPath prefix.
 * 3x-ui uses a custom webPath (e.g. "/mysecret/") that must be prepended to all paths.
 */
function buildProbeUrls(baseUrl, webPath) {
  const urls = [baseUrl]; // Always probe the origin first

  const paths = ['/login', '/panel/inbounds', '/server/status', '/xui/inbounds', '/api/panel/api/inbounds'];
  // If webPath is known, prepend it
  const prefix = webPath ? '/' + webPath.replace(/^\/+|\/+$/g, '') : '';

  for (const p of paths) {
    const full = prefix ? `${baseUrl}${prefix}${p}` : `${baseUrl}${p}`;
    urls.push(full);
  }

  // Also probe the webPath root itself
  if (prefix) {
    urls.push(`${baseUrl}${prefix}/`);
    urls.push(`${baseUrl}${prefix}/login`);
  }

  return urls;
}

// ── Main detection flow ────────────────────────────────────────────

async function main() {
  console.log('Detecting existing 3x-ui installations (best-effort)...');
  const state = await loadState();

  // Reset previous detection results to avoid stale data
  state.xui = {
    detected: false,
    candidates: [],
    probes: [],
    probesResults: [],
    configSettings: null,
    envDiscoveries: [],
    authTests: { unauthenticated: [], loginAttempts: [] },
    authenticated: false,
  };

  let webPath = ''; // Will be set from config DB if found

  // 1) Discover from .env files
  const envDiscoveries = discoverFromEnvFiles();
  state.xui.envDiscoveries = envDiscoveries;
  for (const d of envDiscoveries) {
    let url = d.url;
    // Ensure it has a protocol
    if (!url.includes('://')) url = `http://${url}`;
    if (!state.xui.probes.find((x) => x.url === url)) {
      state.xui.probes.push({ url, from: d.source });
    }
  }

  // 2) Docker container detection
  const dockerCandidates = await detectDockerContainers();
  for (const c of dockerCandidates) {
    const inspect = await inspectContainer(c.name);
    const candidate = { method: 'docker', name: c.name, image: c.image, portsRaw: c.portsRaw, inspect };
    state.xui.candidates.push(candidate);

    // Form candidate base URLs from published ports
    let addedProbe = false;
    if (inspect && inspect.published && inspect.published.length) {
      for (const p of inspect.published) {
        const host = p.hostIp && p.hostIp !== '0.0.0.0' ? p.hostIp : 'localhost';
        const base = `http://${host}:${p.hostPort}`;
        if (!state.xui.probes.find((x) => x.url === base)) {
          state.xui.probes.push({ url: base, from: `docker:${c.name}:${p.containerPort}` });
        }
        addedProbe = true;
      }
    }

    // Fallback: parse portsRaw
    if (!addedProbe && c.portsRaw) {
      try {
        const re = /(?:0\.0\.0\.0|\[::\]):(\d+)->/g;
        let m;
        while ((m = re.exec(c.portsRaw)) !== null) {
          const hostPort = m[1];
          const base = `http://localhost:${hostPort}`;
          if (!state.xui.probes.find((x) => x.url === base)) {
            state.xui.probes.push({ url: base, from: `docker:${c.name}:portsRaw` });
          }
        }
      } catch (e) { /* non-fatal */ }
    }

    // Check container env vars for panel URL hints
    if (inspect && inspect.envVars) {
      for (const [key, value] of Object.entries(inspect.envVars)) {
        if (/URL|BASE/i.test(key) && value && value.includes('://')) {
          if (!state.xui.probes.find((x) => x.url === value)) {
            state.xui.probes.push({ url: value, from: `docker-env:${c.name}:${key}` });
          }
        }
      }
    }
  }

  // 3) Systemd detection
  const systemd = await detectSystemdService();
  for (const s of systemd) {
    state.xui.candidates.push({ method: 'systemd', service: s.service, statusRaw: s.statusRaw });
    const common = [80, 443, 2052, 2053, 8080, 3000, 3001];
    for (const p of common) {
      const base = `http://localhost:${p}`;
      if (!state.xui.probes.find((x) => x.url === base)) {
        state.xui.probes.push({ url: base, from: `systemd:${s.service}` });
      }
    }
  }

  // 4) Host file detection
  const hostPaths = ['/opt/3x-ui', '/opt/xui', '/etc/3x-ui', '/var/lib/3x-ui', '/usr/local/3x-ui', '/usr/local/x-ui'];
  for (const p of hostPaths) {
    try {
      if (fs.existsSync(p)) {
        state.xui.candidates.push({ method: 'host-files', path: p });
        const base = 'http://localhost:2053';
        if (!state.xui.probes.find((x) => x.url === base)) {
          state.xui.probes.push({ url: base, from: `hostfile:${p}` });
        }
      }
    } catch (e) { /* ignore */ }
  }

  // 5) Read 3x-ui SQLite config database
  const xuiDbPaths = ['/etc/3x-ui/3x-ui.db', '/opt/3x-ui/3x-ui.db', '/var/lib/3x-ui/3x-ui.db', '/usr/local/3x-ui/3x-ui.db', '/usr/local/x-ui/3x-ui.db'];
  for (const dbPath of xuiDbPaths) {
    try {
      if (!fs.existsSync(dbPath)) continue;
      state.xui.candidates.push({ method: 'config-db', path: dbPath });
      const settings = await readXuiConfigDb(dbPath);
      if (!settings) continue;

      state.xui.configSettings = settings;
      webPath = settings.webPath || '';
      const webPort = settings.webPort || '2053';
      const webDomain = settings.webDomain || '';
      const webCertFile = settings.webCertFile || '';
      const tlsEnabled = !!(webCertFile && fs.existsSync(webCertFile));
      const protocol = tlsEnabled ? 'https' : 'http';
      const host = webDomain || 'localhost';
      const pathPrefix = webPath ? '/' + webPath.replace(/^\/+|\/+$/g, '') : '';

      const configUrl = `${protocol}://${host}:${webPort}${pathPrefix}`;
      if (!state.xui.probes.find((x) => x.url === configUrl)) {
        state.xui.probes.push({ url: configUrl, from: `config-db:${dbPath}` });
      }

      console.log(`Config DB found at ${dbPath}: port=${webPort}, domain=${webDomain || '(none)'}, path=${webPath || '(none)'}, tls=${tlsEnabled}`);
      break; // Use first found config DB
    } catch (e) { /* non-fatal */ }
  }

  // 6) Add CLI --base-url if provided
  if (CLI.baseUrl) {
    if (!state.xui.probes.find((x) => x.url === CLI.baseUrl)) {
      state.xui.probes.push({ url: CLI.baseUrl, from: 'cli:base-url' });
    }
  }

  // 7) Deduplicate probes
  state.xui.probes = state.xui.probes.filter((p, idx, arr) => arr.findIndex((q) => q.url === p.url) === idx);

  // 8) Expand each base probe with path variations (respecting webPath)
  const expandedProbes = [];
  const seenUrls = new Set(state.xui.probes.map((p) => p.url));
  for (const p of state.xui.probes.slice()) {
    try {
      const u = new URL(p.url.includes('://') ? p.url : `http://${p.url}`);
      const origin = u.origin;
      const extraUrls = buildProbeUrls(origin, webPath);
      for (const eu of extraUrls) {
        if (!seenUrls.has(eu)) {
          expandedProbes.push({ url: eu, from: p.from });
          seenUrls.add(eu);
        }
      }
    } catch (e) { /* ignore malformed */ }
  }
  state.xui.probes.push(...expandedProbes);

  // 9) Probe all candidate URLs using Node.js http/https
  console.log(`Probing ${state.xui.probes.length} candidate URLs...`);

  const probePromises = state.xui.probes.map(async (p) => {
    const res = await httpProbe(p.url, { insecure: CLI.insecure, method: 'GET', timeout: 6000 });
    return {
      url: p.url,
      from: p.from,
      statusCode: res.statusCode,
      headers: res.headers,
      bodySnippet: res.body ? res.body.substring(0, 500) : '',
      error: res.error,
      timestamp: new Date().toISOString(),
    };
  });

  const probeResults = await Promise.all(probePromises);
  state.xui.probesResults = probeResults;

  // 10) Score and pick the best probe
  function scoreProbe(r) {
    let score = 0;
    // Strongly penalize 404 (wrong path)
    if (r.statusCode === 404) score -= 10;
    // Reward 2xx
    if (r.statusCode >= 200 && r.statusCode < 300) score += 10;
    // Reward 3xx (redirect, often login page)
    if (r.statusCode >= 300 && r.statusCode < 400) score += 5;
    // Content match for 3x-ui
    if (r.bodySnippet && /3x-?ui|xui|xray|panel|login|inbound/i.test(r.bodySnippet)) score += 8;
    // Penalize connection errors
    if (r.error) score -= 5;
    // Prefer origin (shorter path)
    try {
      const u = new URL(r.url);
      const depth = u.pathname.split('/').filter(Boolean).length;
      score += Math.max(0, 3 - depth);
    } catch (e) { /* ignore */ }
    return score;
  }

  let best = null;
  let bestScore = -9999;
  for (const r of probeResults) {
    const s = scoreProbe(r);
    if (s > bestScore) {
      bestScore = s;
      best = r;
    }
  }

  state.xui.selected = best && bestScore > 0
    ? { url: best.url, from: best.from, scoreHint: `HTTP ${best.statusCode}, score=${bestScore}` }
    : (best ? { url: best.url, from: best.from, scoreHint: `HTTP ${best.statusCode}, score=${bestScore}` } : null);

  // 11) Run unauthenticated checks on the best candidate
  if (best && best.url) {
    const baseUrl = best.url;
    const checkPaths = ['/login', '/panel/inbounds', '/server/status', '/xui/inbounds', '/api/panel/api/inbounds'];
    const prefix = webPath ? '/' + webPath.replace(/^\/+|\/+$/g, '') : '';

    for (const p of checkPaths) {
      const full = prefix ? `${new URL(baseUrl).origin}${prefix}${p}` : `${new URL(baseUrl).origin}${p}`;
      const res = await httpProbe(full, { insecure: CLI.insecure, method: 'GET', timeout: 6000 });
      state.xui.authTests.unauthenticated.push({
        url: full,
        statusCode: res.statusCode,
        bodySnippet: res.body ? res.body.substring(0, 500) : '',
        error: res.error,
        timestamp: new Date().toISOString(),
      });
    }

    // 12) Optional login attempts
    if (CLI.username && CLI.password) {
      const loginPaths = ['/login', '/api/login', '/auth/login'];
      for (const p of loginPaths) {
        const full = prefix ? `${new URL(baseUrl).origin}${prefix}${p}` : `${new URL(baseUrl).origin}${p}`;
        try {
          const body = `username=${encodeURIComponent(CLI.username)}&password=${encodeURIComponent(CLI.password)}`;
          const res = await httpProbe(full, {
            insecure: CLI.insecure,
            method: 'POST',
            timeout: 8000,
          });
          // We can't easily send POST body with our simple httpProbe, so use a more direct approach
          const loginResult = await new Promise((resolve) => {
            const urlObj = new URL(full);
            const isHttps = urlObj.protocol === 'https:';
            const client = isHttps ? https : http;
            const payload = body;
            const req = client.request({
              method: 'POST',
              hostname: urlObj.hostname,
              port: urlObj.port || (isHttps ? 443 : 80),
              path: urlObj.pathname + (urlObj.search || ''),
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(payload),
                'User-Agent': 'vpn-saas-installer/1.0',
              },
              timeout: 8000,
              rejectUnauthorized: !CLI.insecure,
              agent: isHttps && CLI.insecure ? new https.Agent({ rejectUnauthorized: false }) : undefined,
            }, (res2) => {
              let data = '';
              res2.setEncoding('utf8');
              res2.on('data', (c) => (data += c));
              res2.on('end', () => {
                resolve({ statusCode: res2.statusCode, headers: res2.headers, body: data });
              });
            });
            req.on('error', (e) => resolve({ error: e.message }));
            req.on('timeout', () => req.destroy(new Error('timeout')));
            req.write(payload);
            req.end();
          });

          const setCookie = loginResult.headers && loginResult.headers['set-cookie'];
          const jwt = (loginResult.body || '').match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
          const success = !!(setCookie || jwt);
          state.xui.authTests.loginAttempts.push({
            url: full,
            statusCode: loginResult.statusCode || 0,
            success,
            setCookie: !!setCookie,
            jwt: jwt ? jwt[0] : null,
            timestamp: new Date().toISOString(),
          });
          if (success) {
            state.xui.authenticated = true;
            state.xui.authenticatedAt = new Date().toISOString();
            break;
          }
        } catch (e) {
          state.xui.authTests.loginAttempts.push({ url: full, error: e.message, timestamp: new Date().toISOString() });
        }
      }
    }
  }

  // 13) Final detection decision — require concrete evidence
  const contentMatch = (snippet) => !!(snippet && /3x-?ui|xui|xray|panel|inbound|login/i.test(snippet));

  const hasGoodProbe = probeResults.some((r) =>
    r.statusCode >= 200 && r.statusCode < 400 && contentMatch(r.bodySnippet)
  );

  const hasUnauthMatch = state.xui.authTests.unauthenticated.some((a) =>
    a.statusCode >= 200 && a.statusCode < 400 && contentMatch(a.bodySnippet)
  );

  const loginSuccess = state.xui.authTests.loginAttempts.some((a) => a.success);

  const hasContainerCandidate = state.xui.candidates.some((c) => c.method === 'docker');
  const hasSystemdCandidate = state.xui.candidates.some((c) => c.method === 'systemd');
  const hasHostFileCandidate = state.xui.candidates.some((c) => c.method === 'host-files');
  const hasConfigDb = state.xui.candidates.some((c) => c.method === 'config-db');

  // Require: (content match in probe) OR (content match in unauth) OR (login success)
  // OR (docker/systemd/hostfile/configdb candidate AND at least one non-404 response)
  const hasNon404Response = probeResults.some((r) => r.statusCode > 0 && r.statusCode !== 404);
  const hasInfrastructureCandidate = hasContainerCandidate || hasSystemdCandidate || hasHostFileCandidate || hasConfigDb;

  const finalDetected = hasGoodProbe || hasUnauthMatch || loginSuccess ||
    (hasInfrastructureCandidate && hasNon404Response && hasConfigDb);

  state.xui.detected = finalDetected;
  state.xui.detectedAt = finalDetected ? new Date().toISOString() : null;

  // Save state
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    console.log('detect-xui: results saved to', STATE_PATH);
  } catch (e) {
    console.error('Failed to write state file:', e);
    process.exit(2);
  }

  // Print concise summary
  console.log('--- detect-xui summary ---');
  console.log('Candidates found:', state.xui.candidates.length);
  console.log('Probes attempted:', state.xui.probesResults.length);
  console.log('WebPath from config:', webPath || '(none)');
  console.log('Env discoveries:', envDiscoveries.length);
  console.log('Detected:', state.xui.detected ? 'YES' : 'NO');
  if (state.xui.selected) {
    console.log('Selected URL:', state.xui.selected.url, `(${state.xui.selected.scoreHint})`);
  }
  if (!state.xui.detected) {
    console.log('No reachable 3x-ui endpoint detected automatically.');
    console.log('You can re-run with --base-url=http://host:port to test a specific URL.');
  } else {
    const positives = probeResults.filter((r) => r.statusCode > 0 && r.statusCode !== 404);
    console.log('Positive probes:', positives.map((p) => `${p.url} (HTTP ${p.statusCode})`).slice(0, 10));
  }

  process.exit(0);
}

main();