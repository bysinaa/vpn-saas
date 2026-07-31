#!/usr/bin/env node
/**
 * detect-db.js
 *
 * Purpose:
 *  - Best-effort, non-destructive discovery of PostgreSQL instances that may be
 *    relevant to Tazaxy VPN SaaS or 3X-UI.
 *  - Gather docker containers, docker-compose service references, env files,
 *    open ports, systemd services and candidate credentials found in files.
 *  - Produce a safe installer-state.json update and a suggested database registry.
 *
 * Notes / Safety Rules:
 *  - NEVER modifies databases, users, passwords or containers.
 *  - NEVER attempts to ALTER existing users or reset passwords.
 *  - If credentials are not discoverable, it will not attempt to brute-force or change anything.
 *  - Writes discovered information to installer-state.json (encrypted if configured).
 *  - Attempts to write a registry to /opt/tazaxy/config/database.json when possible,
 *    otherwise writes ./deploy/database-registry.suggested.json and warns the user.
 *
 * Usage:
 *   node cli/installer/detect-db.js
 */
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

const STATE_PATH = path.resolve(process.cwd(), 'installer-state.json');
const SUGGESTED_REGISTRY_LOCAL = path.resolve(process.cwd(), 'deploy', 'database-registry.suggested.json');
const OFFICIAL_REGISTRY_PATH = '/opt/tazaxy/config/database.json';

const _stateManager = require('./state-manager');
const loadState = () => _stateManager.loadState(STATE_PATH);
const saveState = (s) => _stateManager.saveState(STATE_PATH, s);

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

async function dockerPs() {
  const res = await runCmd('docker ps --format "{{.Names}}||{{.Image}}||{{.Ports}}" || true', { timeout: 5000 });
  if (!res.success || !res.stdout) return [];
  return res.stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const parts = l.split('||');
    return { raw: l, name: parts[0] || '', image: parts[1] || '', portsRaw: parts[2] || '' };
  });
}

async function dockerInspect(name) {
  const res = await runCmd(`docker inspect ${name} --format '{{json .}}' || true`, { timeout: 5000 });
  if (!res.success || !res.stdout) return null;
  try {
    const obj = JSON.parse(res.stdout);
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
    const env = (obj.Config && obj.Config.Env) || [];
    return { published, containerIP, mounts, image: obj.Config?.Image || '', env };
  } catch (e) {
    return { error: 'inspect-parse-failed', raw: res.stdout };
  }
}

function parseEnvFileForPostgres(envContent) {
  // extract POSTGRES_*, DATABASE_URL, and PG* variables
  const lines = envContent.split(/\r?\n/);
  const out = {};
  for (const l of lines) {
    const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2] || '';
    // remove quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (/^POSTGRES_|^PG|DATABASE_URL|DB_|^DB/.test(key) || /postgresql:\/\/|postgres:\/\//i.test(val)) {
      out[key] = val;
    }
  }
  return out;
}

async function gatherEnvFiles() {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(process.cwd(), 'deploy', 'infrastructure', 'postgres', '.env'),
    path.resolve(process.cwd(), 'deploy', 'infrastructure', 'shared', '.env'),
    path.resolve(process.cwd(), 'docker-compose.yml'),
    path.resolve(process.cwd(), 'docker-compose.override.yml'),
    path.resolve(process.cwd(), 'docker-compose.prod.yml'),
  ];
  const found = [];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const content = fs.readFileSync(p, 'utf8');
        found.push({ path: p, parsed: parseEnvFileForPostgres(content), raw: content.length > 0 ? '[present]' : '[empty]' });
      }
    } catch (e) {
      // ignore
    }
  }
  // Also search repo for files that mention POSTGRES or DATABASE_URL (best-effort)
  try {
    const search = await runCmd(`grep -R --line-number -I -E "POSTGRES_|DATABASE_URL|postgresql://" . || true`, { timeout: 8000 });
    if (search && search.stdout) {
      const hits = search.stdout.split('\n').filter(Boolean).slice(0, 200).map((line) => {
        const parts = line.split(':');
        const file = parts[0];
        const ln = parts[1];
        const snippet = parts.slice(2).join(':').trim();
        return { file, ln, snippet };
      });
      return { files: found, hits };
    }
  } catch (e) {
    // grep may fail on Windows; ignore
  }
  return { files: found, hits: [] };
}

async function parseDockerComposeForPostgres() {
  const out = [];
  const paths = [
    path.resolve(process.cwd(), 'docker-compose.yml'),
    path.resolve(process.cwd(), 'docker-compose.override.yml'),
    path.resolve(process.cwd(), 'docker-compose.prod.yml'),
    path.resolve(process.cwd(), 'deploy', 'infrastructure', 'postgres', 'docker-compose.yml'),
  ];
  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) continue;
      const txt = fs.readFileSync(p, 'utf8');
      // lightweight heuristics: look for service names and image: postgres
      const serviceRe = /services:\s*([\s\S]*)/i;
      const lines = txt.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (/image:\s*.*postgres/i.test(l) || /image:\s*.*postgis/i.test(l) || /image:\s*.*timescale/i.test(l) || /image:\s*.*bitnami\/postgresql/i.test(l)) {
          // try to find a service name above (previous non-empty line with no indentation)
          let svc = null;
          for (let j = i - 1; j >= 0 && j >= i - 10; j--) {
            const cand = lines[j];
            const m = cand.match(/^(\s*)([a-z0-9A-Z_\-]+):\s*$/);
            if (m && m[1].length === 0) {
              svc = m[2];
              break;
            }
            if (m && m[1].length > 0) {
              // nested block, maybe service key with indentation 2
              svc = m[2];
              break;
            }
          }
          out.push({ path: p, service: svc || null, snippet: l.trim() });
        }
      }
    } catch (e) {
      // ignore
    }
  }
  return out;
}

async function detectSystemd() {
  const candidates = ['postgresql', 'postgres', 'postgresql@12-main', 'postgresql@13-main'];
  const found = [];
  for (const s of candidates) {
    const res = await runCmd(`systemctl status ${s} || true`, { timeout: 3000 });
    if (res.success && res.stdout && !/could not be found|not-found/i.test(res.stdout)) {
      found.push({ service: s, statusRaw: res.stdout });
    }
  }
  return found;
}

async function detectOpenPorts(portsToCheck = [5432, 5433, 5434]) {
  const listening = [];
  for (const p of portsToCheck) {
    // try ss, then netstat, then fallback to tcp connect
    let found = false;
    try {
      const ss = await runCmd(`ss -ltnp | grep -E ":${p}\\b" || true`, { timeout: 2000 });
      if (ss && ss.stdout) {
        listening.push({ port: p, raw: ss.stdout });
        found = true;
      }
    } catch (e) {}
    if (!found) {
      try {
        const netstat = await runCmd(`netstat -plnt 2>/dev/null | grep -E ":${p}\\b" || true`, { timeout: 2000 });
        if (netstat && netstat.stdout) {
          listening.push({ port: p, raw: netstat.stdout });
          found = true;
        }
      } catch (e) {}
    }
    if (!found) {
      // TCP connect to localhost:p to see if something accepts a connection
      const ok = await new Promise((resolve) => {
        const s = new net.Socket();
        let finished = false;
        s.setTimeout(1000);
        s.on('connect', () => { finished = true; s.destroy(); resolve(true); });
        s.on('timeout', () => { if (!finished) { finished = true; s.destroy(); resolve(false); } });
        s.on('error', () => { if (!finished) { finished = true; s.destroy(); resolve(false); } });
        s.connect(p, '127.0.0.1');
      });
      if (ok) listening.push({ port: p, raw: 'tcp-connect-success' });
    }
  }
  return listening;
}

function buildCandidateRecord({ source, type, host, port, container, image, mounts, envVars, composeFile, serviceName, credentialsFound }) {
  return { source, type, host, port, container: container || null, image: image || null, mounts: mounts || [], envVars: envVars || {}, composeFile: composeFile || null, serviceName: serviceName || null, credentialsFound: credentialsFound || {} , timestamp: new Date().toISOString() };
}

async function attemptTcpProbe(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let finished = false;
    s.setTimeout(timeoutMs);
    s.on('connect', () => { finished = true; s.destroy(); resolve({ ok: true }); });
    s.on('timeout', () => { if (!finished) { finished = true; s.destroy(); resolve({ ok: false, reason: 'timeout' }); } });
    s.on('error', (e) => { if (!finished) { finished = true; s.destroy(); resolve({ ok: false, reason: 'error', error: String(e) }); } });
    s.connect(port, host);
  });
}

async function main() {
  console.log('Database discovery: scanning for PostgreSQL instances (non-destructive)...');
  const state = loadState();
  state.databases = state.databases || { discovered: [], registrySuggested: null, notes: [] };

  // 1) Env files
  const envScan = await gatherEnvFiles();
  if (envScan.files && envScan.files.length) {
    for (const f of envScan.files) {
      const creds = f.parsed || {};
      if (Object.keys(creds).length) {
        state.databases.discovered.push(buildCandidateRecord({ source: `envfile:${f.path}`, type: 'envfile', host: creds.POSTGRES_HOST || creds.DB_HOST || 'localhost', port: creds.POSTGRES_PORT || creds.DB_PORT || 5432, envVars: creds, credentialsFound: creds }));
      }
    }
  }
  if (envScan.hits && envScan.hits.length) {
    state.databases.notes.push({ type: 'repo-grep-hits', hits: envScan.hits.slice(0, 50) });
  }

  // 2) Docker detection
  const dockerList = await dockerPs();
  for (const c of dockerList) {
    // Heuristic: image contains "postgres" or name contains "postgres" or common names used by 3x-ui
    if (/postgres|postgresql|postgis|timescale|bitnami\/postgresql/i.test(c.image) || /postgres|postgresql|x-ui-postgres|xui-postgres|xui_db|xui_db/i.test(c.name)) {
      const inspect = await dockerInspect(c.name);
      // collect env vars from container config (may include POSTGRES_PASSWORD etc)
      const envVars = {};
      if (inspect && Array.isArray(inspect.env)) {
        for (const e of inspect.env) {
          const m = e.match(/^([^=]+)=(.*)$/);
          if (m) envVars[m[1]] = m[2];
        }
      }
      // published ports -> host ports
      const pubs = (inspect && inspect.published) || [];
      if (pubs.length === 0 && c.portsRaw) {
        // parse portsRaw fallback
        const re = /(?:0\.0\.0\.0|\[::\]):(\d+)->/g;
        let mm;
        while ((mm = re.exec(c.portsRaw)) !== null) {
          pubs.push({ hostPort: mm[1], containerPort: null, hostIp: '0.0.0.0' });
        }
      }
      if (pubs.length) {
        for (const p of pubs) {
          const host = (p.hostIp && p.hostIp !== '0.0.0.0') ? p.hostIp : 'localhost';
          const port = parseInt(p.hostPort || 5432, 10);
          const creds = {};
          // try to pull common env names
          ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'PGUSER', 'PGPASSWORD', 'DATABASE_URL'].forEach((k) => {
            if (envVars[k]) creds[k] = envVars[k];
          });
          state.databases.discovered.push(buildCandidateRecord({ source: `docker:${c.name}`, type: 'docker', host, port, container: c.name, image: c.image, mounts: (inspect && inspect.mounts) || [], envVars, credentialsFound: creds }));
        }
      } else {
        // no published ports: still add container internal info
        state.databases.discovered.push(buildCandidateRecord({ source: `docker:${c.name}`, type: 'docker', host: inspect && inspect.containerIP ? inspect.containerIP : null, port: 5432, container: c.name, image: c.image, mounts: (inspect && inspect.mounts) || [], envVars, credentialsFound: {} }));
      }
    }
  }

  // 3) Docker-compose heuristics
  const composeMatches = await parseDockerComposeForPostgres();
  if (composeMatches && composeMatches.length) {
    for (const m of composeMatches) {
      state.databases.notes.push({ type: 'compose-suggest', path: m.path, service: m.service, snippet: m.snippet });
    }
  }

  // 4) systemd / host services
  const systemd = await detectSystemd();
  if (systemd && systemd.length) {
    for (const s of systemd) {
      state.databases.discovered.push(buildCandidateRecord({ source: `systemd:${s.service}`, type: 'systemd', host: 'localhost', port: 5432, composeFile: null, serviceName: s.service }));
    }
  }

  // 5) open ports / tcp probes
  const listening = await detectOpenPorts([5432, 5433, 5434, 5435]);
  if (listening && listening.length) {
    for (const l of listening) {
      // Avoid duplicating records for the same port if docker candidate already exists
      const already = state.databases.discovered.find((d) => String(d.port) === String(l.port) && (d.host === 'localhost' || d.host === '127.0.0.1' || d.host === null || d.host === undefined));
      if (!already) {
        const probe = await attemptTcpProbe('127.0.0.1', l.port, 800);
        state.databases.discovered.push(buildCandidateRecord({ source: `tcp-listen:127.0.0.1:${l.port}`, type: 'tcp-listen', host: '127.0.0.1', port: l.port, credentialsFound: {}, envVars: {} }));
      } else {
        // annotate existing record with listen info
        already.listen = l.raw;
      }
    }
  }

  // 6) Attempt to score and suggest registry entries (non-destructive)
  // Priority for registry:
  //  - If a discovered candidate contains explicit credentials in env files or container env, prefer reusing and mark managed=false
  //  - If we find a container that is clearly created by this project (image name or compose file path includes 'postgres' under deploy/infrastructure/postgres), mark managed=true
  const suggested = [];
  for (const c of state.databases.discovered) {
    const creds = c.credentialsFound || {};
    const candidate = {
      type: 'postgres',
      host: c.host || 'localhost',
      port: c.port || 5432,
      database: (creds.POSTGRES_DB || creds.DATABASE || creds.DB_NAME || creds.POSTGRES_DB || 'vpn_saas'),
      owner: null,
      managed: false,
      source: c.source,
      credentials: Object.keys(creds).length ? creds : undefined,
    };
    // heuristics to determine owner
    if (/xui|3x|x-ui/i.test(c.container || (c.source || ''))) {
      candidate.owner = '3x-ui';
    } else if (/vpn|tazaxy|vpn_saas|vpn-saas|tazaxy/i.test(c.container || (c.source || ''))) {
      candidate.owner = 'tazaxy';
    } else if (c.source && c.source.startsWith('envfile')) {
      candidate.owner = 'unknown';
    } else {
      candidate.owner = 'unknown';
    }
    // mark managed=true if compose path or deploy path hints at tazaxy-managed postgres
    if ((c.source && /deploy\/infrastructure\/postgres/i.test(String(c.source))) || (c.image && /tazaxy|vpn-saas/i.test(String(c.image)))) {
      candidate.managed = true;
    }
    // If credentials were found in env files or container env, set managed=false (do not change)
    if (c.credentialsFound && Object.keys(c.credentialsFound).length) {
      candidate.managed = false;
    }
    suggested.push(candidate);
  }

  // Deduplicate suggested by host+port
  const registryByHostPort = {};
  for (const s of suggested) {
    const key = `${s.host || 'localhost'}:${s.port || 5432}`;
    if (!registryByHostPort[key]) registryByHostPort[key] = s;
    else {
      // prefer entry with credentials present
      if (!registryByHostPort[key].credentials && s.credentials) registryByHostPort[key] = s;
    }
  }
  const registrySuggested = { databases: Object.values(registryByHostPort) };

  state.databases.registrySuggested = registrySuggested;

  // 7) Persist installer-state.json
  try {
    saveState(state);
    console.log('installer-state.json updated with database discovery results.');
  } catch (e) {
    console.error('Failed to write installer-state.json:', e && e.message ? e.message : e);
  }

  // 8) Try to write official registry path if possible (non-fatal)
  try {
    const registryDir = path.dirname(OFFICIAL_REGISTRY_PATH);
    const payload = JSON.stringify(registrySuggested, null, 2);
    if (fs.existsSync(registryDir) || fs.existsSync('/opt')) {
      // attempt to create directory if not exists (may fail without privileges)
      try { fs.mkdirSync(registryDir, { recursive: true }); } catch (e) {}
      try {
        fs.writeFileSync(OFFICIAL_REGISTRY_PATH, payload, { encoding: 'utf8', mode: 0o640 });
        console.log(`Registry written to ${OFFICIAL_REGISTRY_PATH}`);
      } catch (e) {
        // fallback to suggested local path
        try {
          fs.mkdirSync(path.dirname(SUGGESTED_REGISTRY_LOCAL), { recursive: true });
          fs.writeFileSync(SUGGESTED_REGISTRY_LOCAL, payload, 'utf8');
          console.log(`Insufficient privileges to write ${OFFICIAL_REGISTRY_PATH}. Wrote suggested registry to ${SUGGESTED_REGISTRY_LOCAL}`);
        } catch (e2) {
          console.error('Failed to write suggested registry file:', e2 && e2.message ? e2.message : e2);
        }
      }
    } else {
      // no /opt (likely Windows), write suggested local path
      fs.mkdirSync(path.dirname(SUGGESTED_REGISTRY_LOCAL), { recursive: true });
      fs.writeFileSync(SUGGESTED_REGISTRY_LOCAL, payload, 'utf8');
      console.log(`No /opt visible. Wrote suggested registry to ${SUGGESTED_REGISTRY_LOCAL}`);
    }
  } catch (e) {
    console.error('Registry write step failed (non-fatal):', e && e.message ? e.message : e);
  }

  // Print a concise summary
  console.log('Discovered candidates:', state.databases.discovered.length);
  state.databases.discovered.slice(0, 50).forEach((d, i) => {
    console.log(`#${i + 1}: source=${d.source} host=${d.host} port=${d.port} container=${d.container || '-'} creds=${d.credentialsFound ? Object.keys(d.credentialsFound).length : 0}`);
  });
  console.log('Suggested registry entries:', registrySuggested.databases.length);
  registrySuggested.databases.forEach((r, i) => {
    console.log(`#${i + 1}: host=${r.host} port=${r.port} database=${r.database} owner=${r.owner} managed=${r.managed} creds=${r.credentials ? Object.keys(r.credentials).length : 0}`);
  });

  console.log('\nNext steps (recommendation):');
  console.log('- Review the suggested registry at', OFFICIAL_REGISTRY_PATH, 'or', SUGGESTED_REGISTRY_LOCAL);
  console.log('- If an existing PostgreSQL instance is being reused, ensure credentials are preserved and accessible.');
  console.log('- If credentials are unavailable for an existing instance, either provide them or select to create an isolated PostgreSQL for VPN SaaS during installation.');
  console.log('- Installer and other stages will consult installer-state.json and the registry to decide actions. No changes have been made by this discovery run.');
}

main().catch((e) => {
  console.error('detect-db: unexpected error', e && e.message ? e.message : e);
  process.exit(1);
});