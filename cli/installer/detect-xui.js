#!/usr/bin/env node
/**
 * detect-xui.js
 *
 * Purpose:
 *  - Autodiscover an existing 3x-ui installation on the host.
 *  - Detect installation method: docker/container, systemd/service, or host files.
 *  - Gather published ports, container IPs, mounted volumes, and candidate base URLs.
 *  - Perform shallow HTTP checks against candidate URLs to find reachable API/HTTP endpoints.
 *  - Append findings to installer-state.json (created by preflight).
 *
 * Usage:
 *   node cli/installer/detect-xui.js
 *
 * Notes:
 *  - Best-effort; non-destructive.
 *  - Uses docker CLI and systemctl where available.
 *  - Does not assume specific 3x-ui API paths; probes common paths: /, /login, /status, /health, /api.
 */
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const STATE_PATH = path.resolve(process.cwd(), 'installer-state.json');

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

function expandWithPaths(probes) {
  // Add common API paths to each base probe (idempotent)
  const paths = ['', '/login', '/api', '/health', '/status', '/admin/xui/session', '/admin/xui/test'];
  const added = new Set();
  // Work on a snapshot to avoid infinite loops
  const snapshot = probes.slice();
  for (const p of snapshot) {
    try {
      // Ensure we have a full URL
      const u = new URL(p.url.includes('://') ? p.url : `http://${p.url}`);
      for (const pa of paths) {
        const candidate = pa === '' ? u.origin : (u.origin + pa);
        if (!probes.find((x) => x.url === candidate) && !added.has(candidate)) {
          probes.push({ url: candidate, from: p.from });
          added.add(candidate);
        }
      }
    } catch (e) {
      // ignore malformed URLs
    }
  }
  return probes;
}

async function detectDockerContainers() {
  const out = [];
  const dockerPs = await runCmd('docker ps --format "{{.Names}}||{{.Image}}||{{.Ports}}" || true', { timeout: 5000 });
  if (!dockerPs.success || !dockerPs.stdout) return out;
  const lines = dockerPs.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const l of lines) {
    // Quick heuristic: name or image contains xui, 3x, x-ui, xray-panel etc.
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

async function inspectContainer(name) {
  // get inspect JSON (best-effort)
  const inspect = await runCmd(`docker inspect ${name} --format '{{json .}}' || true`, { timeout: 5000 });
  if (!inspect.success || !inspect.stdout) return null;
  try {
    const obj = JSON.parse(inspect.stdout);
    const networkSettings = obj.NetworkSettings || {};
    const ports = networkSettings.Ports || {};
    const published = [];
    for (const [containerPort, mapping] of Object.entries(ports)) {
      if (mapping && Array.isArray(mapping)) {
        mapping.forEach((m) => {
          published.push({
            containerPort,
            hostIp: m.HostIp,
            hostPort: m.HostPort,
          });
        });
      }
    }
    const containerIP = Object.values(networkSettings.Networks || {})[0]?.IPAddress || null;
    const mounts = (obj.Mounts || []).map((m) => ({ Source: m.Source, Destination: m.Destination, Mode: m.RW ? 'rw' : 'ro' }));
    return { published, containerIP, mounts, image: obj.Config?.Image || '' };
  } catch (e) {
    return { error: 'inspect-parse-failed', raw: inspect.stdout };
  }
}

async function detectSystemdService() {
  // Try common service names
  const candidates = ['3x-ui', 'xui', 'x-ui', 'xray-ui', 'xray-panel'];
  const found = [];
  for (const s of candidates) {
    const st = await runCmd(`systemctl status ${s} || true`, { timeout: 3000 });
    if (st.success && st.stdout && !/could not be found|not-found/i.test(st.stdout)) {
      found.push({ service: s, statusRaw: st.stdout });
    }
  }
  return found;
}

async function probeHttp(url, opts = {}) {
  // Use curl to perform a HEAD and a GET (short) to collect status and headers
  const insecure = !!opts.insecure;
  const headCmd = `curl -I ${insecure ? '-k ' : ''}--max-time 5 -sS -L "${url}" || true`;
  const head = await runCmd(headCmd, { timeout: 7000 });
  let ok = false;
  let statusLine = '';
  if (head && head.stdout) {
    // try to find HTTP/... status
    const m = head.stdout.match(/HTTP\/\d+\.\d+\s+(\d+)/i);
    if (m) statusLine = m[0];
    ok = /HTTP\//.test(head.stdout);
  }
  // Also attempt GET for content sniffing if HEAD looked promising
  let get = null;
  if (ok || head.stdout) {
    const getCmd = `curl -sS ${insecure ? '-k ' : ''}--max-time 5 -L "${url}" || true`;
    get = await runCmd(getCmd, { timeout: 7000 });
  }
  return { head, get, statusLine };
}

async function main() {
  console.log('Detecting existing 3x-ui installations (best-effort)...');
  const state = await loadState();
  state.xui = state.xui || { detected: false, candidates: [], probes: [] };

  // 1) Docker container detection
  const dockerCandidates = await detectDockerContainers();
  for (const c of dockerCandidates) {
    const inspect = await inspectContainer(c.name);
    const candidate = {
      method: 'docker',
      name: c.name,
      image: c.image,
      portsRaw: c.portsRaw,
      inspect,
    };
    state.xui.candidates.push(candidate);

    // Form candidate base URLs from published ports and host
    // Primary: prefer docker inspect published ports (container -> host mapping)
    let addedProbeFromDocker = false;
    if (inspect && inspect.published && inspect.published.length) {
      for (const p of inspect.published) {
        // published.hostPort exists
        const host = p.hostIp && (p.hostIp !== '0.0.0.0') ? p.hostIp : 'localhost';
        const base = `http://${host}:${p.hostPort}`;
        if (!state.xui.probes.find((x) => x.url === base)) {
          state.xui.probes.push({ url: base, from: `docker:${c.name}:${p.containerPort}` });
        }
        // try https variant too
        const baseHttps = `https://${host}:${p.hostPort}`;
        if (!state.xui.probes.find((x) => x.url === baseHttps)) {
          state.xui.probes.push({ url: baseHttps, from: `docker:${c.name}:${p.containerPort}` });
        }
        addedProbeFromDocker = true;
      }
    }

    // Fallback: parse the docker ps portsRaw field when inspect did not yield published ports
    // Example portsRaw: "0.0.0.0:2053->2053/tcp, [::]:2053->2053/tcp"
    if (!addedProbeFromDocker && c.portsRaw) {
      try {
        const portsRaw = c.portsRaw;
        const re = /(?:0\.0\.0\.0|\[::\]):(\d+)->/g;
        let m;
        while ((m = re.exec(portsRaw)) !== null) {
          const hostPort = m[1];
          const base = `http://localhost:${hostPort}`;
          if (!state.xui.probes.find((x) => x.url === base)) {
            state.xui.probes.push({ url: base, from: `docker:${c.name}:portsRaw` });
          }
          const baseHttps = `https://localhost:${hostPort}`;
          if (!state.xui.probes.find((x) => x.url === baseHttps)) {
            state.xui.probes.push({ url: baseHttps, from: `docker:${c.name}:portsRaw` });
          }
        }
      } catch (e) {
        // non-fatal: continue
      }
    }

    // Also add container internal IP (may not be reachable from host)
    if (inspect && inspect.containerIP) {
      const base = `http://${inspect.containerIP}`;
      if (!state.xui.probes.find((x) => x.url === base)) {
        state.xui.probes.push({ url: base, from: `docker:${c.name}:internal` });
      }
    }
  }

  // 2) Systemd detection
  const systemd = await detectSystemdService();
  for (const s of systemd) {
    state.xui.candidates.push({ method: 'systemd', service: s.service, statusRaw: s.statusRaw });
    // try common host ports on localhost
    const common = [80, 443, 2052, 2053, 8080, 3000, 3001];
    for (const p of common) {
      const base = `http://localhost:${p}`;
      state.xui.probes.push({ url: base, from: `systemd:${s.service}` });
      const baseHttps = `https://localhost:${p}`;
      state.xui.probes.push({ url: baseHttps, from: `systemd:${s.service}` });
    }
  }

  // 3) Host file detection (common folders)
  const hostPaths = ['/opt/3x-ui', '/opt/xui', '/etc/3x-ui', '/var/lib/3x-ui', '/usr/local/3x-ui'];
  for (const p of hostPaths) {
    try {
      if (fs.existsSync(p)) {
        state.xui.candidates.push({ method: 'host-files', path: p });
        // try default host URLs
        state.xui.probes.push({ url: 'http://localhost:2052', from: `hostfile:${p}` });
        state.xui.probes.push({ url: 'https://localhost:2053', from: `hostfile:${p}` });
      }
    } catch (e) {
      // ignore
    }
  }

  // 4) Deduplicate docker-derived candidates and probes
  // Deduplicate candidates by a stable key (method + name + image + portsRaw)
  if (state.xui.candidates && state.xui.candidates.length) {
    const seenCandidates = new Set();
    state.xui.candidates = state.xui.candidates.filter((c) => {
      try {
        const key = JSON.stringify({
          method: c.method || '',
          name: c.name || '',
          image: c.image || '',
          portsRaw: c.portsRaw || '',
        });
        if (seenCandidates.has(key)) return false;
        seenCandidates.add(key);
        return true;
      } catch (e) {
        return true;
      }
    });
  }

  // Remove duplicate probe URLs (keep first occurrence)
  state.xui.probes = state.xui.probes.filter((p, idx, arr) => arr.findIndex((q) => q.url === p.url) === idx);

  // 5) Expand probes with common paths and probe each candidate URL for reachability and gather headers/content sample
  if (CLI.baseUrl) {
    const b = CLI.baseUrl;
    if (!state.xui.probes.find((x) => x.url === b)) state.xui.probes.push({ url: b, from: 'cli:base-url' });
    const https = b.replace(/^http:/, 'https:');
    if (!state.xui.probes.find((x) => x.url === https)) state.xui.probes.push({ url: https, from: 'cli:base-url' });
  }

  // expand probes with common API paths
  expandWithPaths(state.xui.probes);

  state.xui.probesResults = [];

  // Parallel probes (fire all concurrently)
  const probePromises = state.xui.probes.map(async (p) => {
    console.log('Probing', p.url, ' (from:', p.from, ')');
    const res = await probeHttp(p.url, { insecure: CLI.insecure });
    return {
      url: p.url,
      from: p.from,
      head: res.head,
      statusLine: res.statusLine,
      get: res.get && res.get.stdout ? { snippet: res.get.stdout.substring(0, 200) } : res.get,
      timestamp: new Date().toISOString(),
    };
  });

  const probeResults = await Promise.all(probePromises);
  state.xui.probesResults.push(...probeResults);

  // 6) Enhanced probe evaluation + optional authentication tests
  function pickBestProbe(results) {
    // Improved scoring:
    // - Prefer origin-only URLs (no path) over path-specific candidates (e.g. /login)
    // - Reward HTTP 2xx, content matches, and shorter path depth
    const scoreFor = (r) => {
      let score = 0;
      try {
        if (r.statusLine && /\s20\d\s/.test(r.statusLine)) score += 5;
      } catch (e) {}
      if (r.get && r.get.snippet && /3x-?ui|xui|xray|panel/i.test(r.get.snippet)) score += 10;

      // Prefer origin (no path) slightly higher than pathed URLs
      try {
        const u = new URL(r.url);
        const pathName = (u.pathname || '/').replace(/\/+$/, '') || '/';
        // If pathname is root, boost it
        if (pathName === '/' || pathName === '') score += 3;
        // Penalize generic login/api paths slightly so origin is preferred when both are identical host/port
        if (/\/login$|\/api$|\/auth\/login|\/admin/i.test(pathName)) score -= 1;
        // Shorter paths preferred
        const depth = pathName.split('/').filter(Boolean).length;
        score += Math.max(0, 2 - depth); // depth 0 => +2, depth1 => +1, depth>=2 => +0
      } catch (e) {
        // ignore URL parse errors
      }

      return score;
    };

    let best = null;
    let bestScore = -9999;
    for (const r of results) {
      const s = scoreFor(r);
      // tiebreak: prefer HTTP over non-HTTP
      const isHttp = !!(r.statusLine && /HTTP\/\d+\.\d+/.test(r.statusLine));
      const tieBreaker = isHttp ? 0.5 : 0;
      const finalScore = s + tieBreaker;
      if (finalScore > bestScore) {
        bestScore = finalScore;
        best = r;
      }
    }
    // If nothing scored positively, prefer the first reachable HTTP candidate
    if (bestScore <= 0) {
      const httpReachable = results.find((r) => r.statusLine && /HTTP\/\d+\.\d+/.test(r.statusLine));
      return httpReachable || results[0] || null;
    }
    return best;
  }

  const selectedProbe = pickBestProbe(state.xui.probesResults);
  state.xui.selected = selectedProbe ? { url: selectedProbe.url, from: selectedProbe.from, scoreHint: selectedProbe.statusLine || null } : null;

  // 6a) Run unauthenticated checks on a few protected-looking endpoints to gather confirmation evidence
  state.xui.authTests = state.xui.authTests || { unauthenticated: [], loginAttempts: [] };

  async function runUnauthChecks(baseUrl) {
    const paths = ['/admin/xui/inbounds', '/api/clients', '/api', '/status', '/health'];
    const results = [];
    for (const p of paths) {
      try {
        const u = new URL(p, baseUrl).toString();
        const res = await probeHttp(u, { insecure: CLI.insecure });
        results.push({ url: u, head: res.head, statusLine: res.statusLine, snippet: res.get && res.get.stdout ? res.get.stdout.substring(0, 500) : null, timestamp: new Date().toISOString() });
      } catch (e) {
        results.push({ url: `${baseUrl}${p}`, error: 'invalid-url', timestamp: new Date().toISOString() });
      }
    }
    return results;
  }

  async function tryLogins(baseUrl) {
    const loginPaths = ['/login', '/api/login', '/auth/login', '/api/auth/login'];
    const attempts = [];
    if (!CLI.username || !CLI.password) return attempts;

    for (const p of loginPaths) {
      try {
        const u = new URL(p, baseUrl).toString();
        // Try form-style login first
        const body = `username=${encodeURIComponent(CLI.username)}&password=${encodeURIComponent(CLI.password)}`;
        const cmd = `curl -i ${CLI.insecure ? '-k ' : ''}--max-time 7 -sS -L -X POST -H "Content-Type: application/x-www-form-urlencoded" --data "${body}" "${u}" || true`;
        const res = await runCmd(cmd, { timeout: 9000 });
        const headers = res.stdout || '';
        const setCookie = /Set-Cookie:/i.test(headers);
        const jwt = (res.stdout || '').match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
        attempts.push({ url: u, code: res.code, success: !!setCookie || !!jwt, setCookie: !!setCookie, jwt: jwt ? jwt[0] : null, raw: (res.stdout || '').substring(0, 1000), timestamp: new Date().toISOString() });
        if (setCookie || jwt) break; // stop on first apparent success
      } catch (e) {
        attempts.push({ url: `${baseUrl}${p}`, error: 'request-failed', timestamp: new Date().toISOString() });
      }
    }
    return attempts;
  }

  if (selectedProbe && selectedProbe.url) {
    try {
      const unauth = await runUnauthChecks(selectedProbe.url);
      state.xui.authTests.unauthenticated.push(...unauth);
    } catch (e) {
      // non-fatal
    }

    try {
      const logins = await tryLogins(selectedProbe.url);
      state.xui.authTests.loginAttempts.push(...logins);
      if (logins.some((a) => a.success)) {
        state.xui.authenticated = true;
        state.xui.authenticatedAt = new Date().toISOString();
      } else {
        state.xui.authenticated = false;
      }
    } catch (e) {
      // non-fatal
    }
  }

  // 6b) Heuristic: if any probe returned an HTTP status or non-empty body containing '3x' or '3x-ui' or 'xui', mark detected
    const detected = state.xui.probesResults.some((r) => {
      if (r.head && r.head.stdout && /HTTP\//.test(r.head.stdout)) return true;
      if (r.get && r.get.snippet && /3x-?ui|xui|xray|panel/i.test(r.get.snippet)) return true;
      if (state.xui.authTests && state.xui.authTests.unauthenticated && state.xui.authTests.unauthenticated.some((a) => a.snippet && /3x-?ui|xui|xray|panel/i.test(a.snippet))) return true;
      return false;
    });

  state.xui.detected = detected;
  state.xui.detectedAt = detected ? new Date().toISOString() : null;

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
  console.log('Detected:', state.xui.detected ? 'YES' : 'NO');
  if (!state.xui.detected) {
    console.log('No reachable 3x-ui endpoint detected automatically. You can re-run with --base-url to test a specific URL.');
  } else {
    const positives = state.xui.probesResults.filter((r) => (r.head && r.head.stdout) || (r.get && r.get.snippet));
    console.log('Positive probes:', positives.map((p) => p.url).slice(0, 10));
  }

  process.exit(0);
}

main();