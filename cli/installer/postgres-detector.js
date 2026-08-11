'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

function parseDatasource(value, source) {
  try {
    const url = new URL(value);
    if (!/^postgres(?:ql)?:$/.test(url.protocol)) throw new Error('not-postgres');
    return { source, connection: { host: url.hostname, port: Number(url.port || 5432), database: decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres' } };
  } catch { return null; }
}

function parseEnv(text) { return Object.fromEntries(String(text || '').split(/\r?\n/).flatMap((line) => { const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*?)\s*$/); return m ? [[m[1], m[2].replace(/^['"]|['"]$/g, '')]] : []; })); }
function candidateKey(candidate) { return `${candidate.connection.host}:${candidate.connection.port}/${candidate.connection.database}`; }

function createPostgresDetector({ runtime = {} } = {}) {
  const local = { exec: runtime.exec || exec, fs: runtime.fs || fs, cwd: runtime.cwd || (() => process.cwd()), path: runtime.path || path, now: runtime.now || (() => new Date()) };
  const run = (command, timeout = 4000) => new Promise((resolve) => local.exec(command, { timeout, shell: true }, (error, stdout, stderr) => resolve({ ok: !error, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() })));
  const exists = (file) => { try { return local.fs.existsSync(file); } catch { return false; } };

  async function discover(options = {}) {
    const diagnostics = [];
    const candidates = new Map();
    const add = (candidate) => { if (candidate) candidates.set(candidateKey(candidate), candidate); };
    const envFiles = ['.env', '.env.example', 'deploy/infrastructure/postgres/.env'].map((file) => local.path.resolve(local.cwd(), file));
    for (const file of envFiles) if (exists(file)) {
      try {
        const env = parseEnv(local.fs.readFileSync(file, 'utf8'));
        add(parseDatasource(env.DATABASE_URL, `config:${local.path.basename(file)}`));
        if (env.POSTGRES_HOST || env.POSTGRES_PORT || env.POSTGRES_DB) add({ source: `config:${local.path.basename(file)}`, connection: { host: env.POSTGRES_HOST || '127.0.0.1', port: Number(env.POSTGRES_PORT || 5432), database: env.POSTGRES_DB || env.VPN_DATABASE || 'tazaxy' } });
      } catch { diagnostics.push({ code: 'CONFIG_READ_FAILED' }); }
    }
    add(parseDatasource(options.datasource || process.env.DATABASE_URL, options.datasource ? 'explicit-datasource' : 'configured-datasource'));
    const docker = await run('docker ps --format "{{.Names}}||{{.Image}}||{{.Ports}}"');
    if (docker.ok) for (const line of docker.stdout.split(/\r?\n/).filter(Boolean)) {
      const [name, image, ports] = line.split('||'); if (!/postgres/i.test(`${name} ${image}`)) continue;
      const port = Number((String(ports).match(/(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]):(\d+)->5432/) || [])[1] || 5432);
      add({ source: 'docker', containerName: name, connection: { host: '127.0.0.1', port, database: 'postgres' } });
    } else diagnostics.push({ code: 'DOCKER_UNAVAILABLE' });
    const compose = await run('docker compose ps --format "{{.Name}}||{{.Image}}||{{.Publishers}}"');
    if (compose.ok && /postgres/i.test(compose.stdout)) add({ source: 'compose', connection: { host: '127.0.0.1', port: 5432, database: 'postgres' } });
    const services = await run('systemctl list-units --type=service --all --no-legend');
    if (services.ok && /postgresql/i.test(services.stdout)) add({ source: 'native-service', connection: { host: '127.0.0.1', port: 5432, database: 'postgres' } });
    const processes = await run(process.platform === 'win32' ? 'tasklist' : 'ps -eo args');
    if (processes.ok && /postgres(?:\s|$)/i.test(processes.stdout)) add({ source: 'process', connection: { host: '127.0.0.1', port: 5432, database: 'postgres' } });
    const wsl = await run('wsl.exe -e sh -lc "ps -eo args"');
    if (wsl.ok && /postgres(?:\s|$)/i.test(wsl.stdout)) add({ source: 'wsl', connection: { host: '127.0.0.1', port: 5432, database: 'postgres' } });
    const checked = await Promise.all([...candidates.values()].map(async (candidate) => {
      const ready = await run(`pg_isready -h ${candidate.connection.host} -p ${candidate.connection.port} -d ${candidate.connection.database}`, 3000);
      return { ...candidate, ready: ready.ok ? /accepting connections/i.test(ready.stdout) : null, diagnostics: ready.ok ? [{ code: /accepting connections/i.test(ready.stdout) ? 'PG_READY' : 'PG_UNREACHABLE' }] : [{ code: 'PG_ISREADY_UNAVAILABLE' }] };
    }));
    const best = checked.sort((a, b) => Number(b.ready) - Number(a.ready))[0];
    return { status: best?.ready ? 'FOUND' : best ? 'PARTIAL' : 'NOT_FOUND', source: best?.source || 'none', containerName: best?.containerName, version: undefined, connection: best?.connection, confidence: best?.ready ? 90 : best ? 50 : 0, candidates: checked, diagnostics, observedAt: local.now().toISOString(), recommendedAction: best?.ready ? 'Select this PostgreSQL candidate; provide credentials only through hidden input if validation is needed.' : best ? 'Verify PostgreSQL is reachable or install pg_isready.' : 'Start PostgreSQL or provide a datasource candidate.' };
  }

  async function validateAuthentication({ candidate, username, password, validate }) {
    if (!candidate?.connection || !username || !password || !validate) return { status: 'ERROR', diagnostics: [{ code: 'MISSING_HIDDEN_CREDENTIALS' }], recommendedAction: 'Provide credentials through hidden interactive input.' };
    const ok = await validate({ ...candidate.connection, username, password });
    return { status: ok ? 'FOUND' : 'ERROR', diagnostics: [{ code: ok ? 'AUTHENTICATED' : 'AUTH_FAILED' }], recommendedAction: ok ? 'Credentials are valid; persist only through the installer adapter.' : 'Verify credentials.' };
  }
  return { discover, validateAuthentication };
}

module.exports = { createPostgresDetector, parseDatasource };
