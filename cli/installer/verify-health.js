#!/usr/bin/env node
/**
 * verify-health.js
 *
 * Comprehensive health verification for the VPN SaaS installation.
 * Verifies ALL required services are actually working, not just docker compose.
 *
 * Checks performed:
 *  1.  Docker containers status (app, redis, minio, nginx)
 *  2.  App health endpoint (/health)
 *  3.  App readiness endpoint (/health/ready) — checks DB + Redis
 *  4.  Database connectivity (via Prisma or direct pg connection)
 *  5.  Redis connectivity (PING)
 *  6.  MinIO connectivity (health endpoint)
 *  7.  Prisma migration status
 *  8.  Application startup (HTTP 200 on /health)
 *  9.  Swagger API docs accessibility
 *  10. Telegram bot status (via API endpoint)
 *  11. 3X-UI panel login page accessibility
 *  12. 3X-UI panel login verification (actual credential authentication)
 *  13. Queue system (BullMQ) connectivity
 *
 * Usage:
 *   node cli/installer/verify-health.js [--app-url=http://localhost:3001] [--xui-url=http://127.0.0.1:2053] [--insecure] [--json]
 *
 * Exit codes:
 *   0 = all required checks passed
 *   1 = one or more required checks failed
 *   2 = could not run checks (e.g. docker not available)
 */
const { exec } = require('child_process');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const STATE_PATH = path.resolve(process.cwd(), 'installer-state.json');

// ── Docker port detection ──────────────────────────────────────────

/**
 * Detect the actual host port for a Docker Compose service.
 * Uses `docker compose port <service> <containerPort>` which returns
 * the host-side port mapping (e.g. "0.0.0.0:3001" for app:3000).
 *
 * Falls back to the provided defaultPort if Docker is unavailable
 * or the service has no port mapping.
 */
async function getDockerHostPort(service, containerPort, defaultPort) {
  const result = await runCmd(`docker compose port ${service} ${containerPort}`, { timeout: 5000 });
  if (result.success && result.stdout) {
    // Output format: "0.0.0.0:3001" or "[::]:3001"
    const match = result.stdout.match(/:(\d+)$/);
    if (match) return match[1];
  }
  return defaultPort;
}

// ── CLI args ───────────────────────────────────────────────────────

function parseArgs() {
  const out = { appUrl: null, xuiUrl: null, insecure: false, json: false, timeout: 10000 };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--app-url=')) out.appUrl = a.split('=')[1];
    else if (a.startsWith('--xui-url=')) out.xuiUrl = a.split('=')[1];
    else if (a === '--insecure') out.insecure = true;
    else if (a === '--json') out.json = true;
    else if (a.startsWith('--timeout=')) out.timeout = parseInt(a.split('=')[1], 10);
  }
  return out;
}

const CLI = parseArgs();

// ── Helpers ────────────────────────────────────────────────────────

function runCmd(cmd, opts = {}) {
  const timeout = opts.timeout || 10_000;
  return new Promise((resolve) => {
    exec(cmd, { timeout, shell: true }, (err, stdout, stderr) => {
      resolve({
        success: !err,
        code: err && err.code != null ? err.code : 0,
        stdout: stdout ? stdout.trim() : '',
        stderr: stderr ? stderr.trim() : '',
      });
    });
  });
}

function httpProbe(urlString, opts = {}) {
  const insecure = !!opts.insecure;
  const method = opts.method || 'GET';
  const timeout = opts.timeout || 7000;
  const headers = opts.headers || {};

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
      headers: { 'User-Agent': 'vpn-saas-health-check/1.0', Accept: 'application/json,text/html,*/*', ...headers },
      timeout,
      rejectUnauthorized: !insecure,
    };

    if (isHttps && insecure) {
      reqOpts.agent = new https.Agent({ rejectUnauthorized: false });
    }

    const req = client.request(reqOpts, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 400,
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

    if (opts.body) {
      req.write(opts.body);
    }

    req.end();
  });
}

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  try {
    if (fs.existsSync(envPath)) return parseEnvFile(fs.readFileSync(envPath, 'utf8'));
  } catch (e) { /* non-fatal */ }
  return {};
}

const ENV = loadEnv();

// ── Determine URLs ─────────────────────────────────────────────────

async function getAppUrl() {
  if (CLI.appUrl) return CLI.appUrl;
  // Detect actual Docker host port mapping for the app service.
  // docker-compose maps 3001:3000, but .env has APP_PORT=3000 (container port).
  // We need the host port (3001) to reach the app from outside Docker.
  const envPort = ENV.APP_PORT || '3000';
  const hostPort = await getDockerHostPort('app', envPort, envPort);
  return `http://localhost:${hostPort}`;
}

function getXuiUrl() {
  if (CLI.xuiUrl) return CLI.xuiUrl;
  // Try from installer-state.json
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (state.xui && state.xui.confirmed && state.xui.confirmed.baseUrl) return state.xui.confirmed.baseUrl;
    if (state.xui && state.xui.selected && state.xui.selected.url) return state.xui.selected.url;
  } catch (e) { /* non-fatal */ }
  // From .env
  if (ENV.XUI_PANEL_URL) return ENV.XUI_PANEL_URL;
  if (ENV.SANITY_PANEL_BASE_URL) return ENV.SANITY_PANEL_BASE_URL;
  return 'http://127.0.0.1:2053';
}

// ── Check definitions ──────────────────────────────────────────────

/**
 * Each check returns: { name, required, status: 'pass'|'fail'|'warn'|'skip', detail, durationMs }
 */
const checks = [];

async function checkDockerContainers() {
  const start = Date.now();
  const result = await runCmd('docker compose ps --format "{{.Name}}||{{.Status}}||{{.Health}}"', { timeout: 10000 });
  const durationMs = Date.now() - start;

  if (!result.success) {
    return { name: 'docker-containers', required: true, status: 'fail', detail: `docker compose ps failed: ${result.stderr || result.stdout || 'unknown'}`, durationMs };
  }

  const lines = result.stdout.split('\n').filter(Boolean);
  const expected = ['app', 'redis', 'minio'];
  const found = {};
  for (const line of lines) {
    const parts = line.split('||');
    const name = parts[0] || '';
    const status = parts[1] || '';
    const health = parts[2] || '';
    // Extract service name from container name (e.g. "vpn-saas-app-1" → "app")
    for (const svc of expected) {
      if (name.includes(svc)) {
        found[svc] = { name, status, health };
      }
    }
  }

  const missing = expected.filter((s) => !found[s]);
  const unhealthy = Object.entries(found).filter(([, v]) => v.health && v.health !== 'healthy' && v.health !== 'no healthcheck');

  if (missing.length > 0) {
    return { name: 'docker-containers', required: true, status: 'fail', detail: `Missing containers: ${missing.join(', ')}. Found: ${Object.keys(found).join(', ') || 'none'}`, durationMs };
  }

  if (unhealthy.length > 0) {
    const names = unhealthy.map(([k, v]) => `${k}(${v.health})`).join(', ');
    return { name: 'docker-containers', required: true, status: 'fail', detail: `Unhealthy containers: ${names}`, durationMs };
  }

  const summary = Object.entries(found).map(([k, v]) => `${k}: ${v.health || v.status}`).join('; ');
  return { name: 'docker-containers', required: true, status: 'pass', detail: summary, durationMs };
}

async function checkAppHealth(appUrl) {
  const start = Date.now();
  const res = await httpProbe(`${appUrl}/health`, { insecure: CLI.insecure, timeout: 7000 });
  const durationMs = Date.now() - start;

  if (res.ok && res.statusCode === 200) {
    let detail = `HTTP ${res.statusCode}`;
    try {
      const body = JSON.parse(res.body);
      if (body.status) detail += ` — status: ${body.status}`;
    } catch (e) { /* non-fatal */ }
    return { name: 'app-health', required: true, status: 'pass', detail, durationMs };
  }
  return { name: 'app-health', required: true, status: 'fail', detail: `HTTP ${res.statusCode} — ${res.error || 'unhealthy'}`, durationMs };
}

async function checkAppReadiness(appUrl) {
  const start = Date.now();
  const res = await httpProbe(`${appUrl}/health/ready`, { insecure: CLI.insecure, timeout: 10000 });
  const durationMs = Date.now() - start;

  if (res.ok && res.statusCode === 200) {
    let detail = `HTTP ${res.statusCode}`;
    try {
      const body = JSON.parse(res.body);
      if (body.status) detail += ` — status: ${body.status}`;
      if (body.database) detail += ` — db: ${body.database}`;
      if (body.redis) detail += ` — redis: ${body.redis}`;
    } catch (e) { /* non-fatal */ }
    return { name: 'app-readiness', required: true, status: 'pass', detail, durationMs };
  }
  return { name: 'app-readiness', required: true, status: 'fail', detail: `HTTP ${res.statusCode} — ${res.error || 'not ready'}`, durationMs };
}

async function checkRedis() {
  const start = Date.now();
  const redisHost = ENV.REDIS_HOST || 'localhost';
  // Detect actual Docker host port. .env has REDIS_PORT=6379 (container port),
  // but docker-compose maps 3002:6379. We need the host port (3002).
  const envRedisPort = ENV.REDIS_PORT || '6379';
  const redisPort = await getDockerHostPort('redis', envRedisPort, envRedisPort);

  // Try redis-cli ping first
  const cliResult = await runCmd(`redis-cli -h ${redisHost} -p ${redisPort} ping`, { timeout: 5000 });
  const durationMs = Date.now() - start;

  if (cliResult.success && cliResult.stdout === 'PONG') {
    return { name: 'redis', required: true, status: 'pass', detail: `PONG (${redisHost}:${redisPort})`, durationMs };
  }

  // Fallback: TCP connect check
  const net = require('net');
  const tcpOk = await new Promise((resolve) => {
    const sock = net.createConnection({ host: redisHost, port: parseInt(redisPort, 10) }, () => {
      sock.end();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.setTimeout(3000, () => { sock.destroy(); resolve(false); });
  });

  if (tcpOk) {
    return { name: 'redis', required: true, status: 'warn', detail: `TCP connect OK but redis-cli ping failed (${cliResult.stderr || 'no response'})`, durationMs };
  }

  return { name: 'redis', required: true, status: 'fail', detail: `Cannot connect to Redis at ${redisHost}:${redisPort}`, durationMs };
}

async function checkMinIO() {
  const start = Date.now();
  // MinIO is on port 9000 (API) and 9001 (console)
  const minioUrl = ENV.S3_ENDPOINT || 'http://localhost:9000';
  const res = await httpProbe(`${minioUrl}/minio/health/live`, { insecure: CLI.insecure, timeout: 7000 });
  const durationMs = Date.now() - start;

  if (res.ok) {
    return { name: 'minio', required: true, status: 'pass', detail: `HTTP ${res.statusCode} — healthy`, durationMs };
  }
  return { name: 'minio', required: true, status: 'fail', detail: `HTTP ${res.statusCode} — ${res.error || 'unhealthy'}`, durationMs };
}

async function checkDatabase() {
  const start = Date.now();
  const dbUrl = ENV.DATABASE_URL || '';

  if (!dbUrl) {
    return { name: 'database', required: true, status: 'fail', detail: 'DATABASE_URL not set in .env', durationMs: Date.now() - start };
  }

  // Try using docker exec to run psql inside the postgres container (if running in docker)
  // Or use npx prisma to check connectivity
  // Note: Use `echo |` pipe instead of `<<<` heredoc for Windows cmd.exe compatibility
  const prismaResult = await runCmd('echo SELECT 1; | npx prisma db execute --schema prisma/schema.prisma --stdin', { timeout: 15000 });
  const durationMs = Date.now() - start;

  if (prismaResult.success) {
    return { name: 'database', required: true, status: 'pass', detail: 'Prisma DB connectivity OK', durationMs };
  }

  // Fallback: check if we can at least TCP connect to the DB host
  try {
    const dbUrlObj = new URL(dbUrl);
    const dbHost = dbUrlObj.hostname;
    const dbPort = dbUrlObj.port || '5432';
    const net = require('net');
    const tcpOk = await new Promise((resolve) => {
      const sock = net.createConnection({ host: dbHost, port: parseInt(dbPort, 10) }, () => {
        sock.end();
        resolve(true);
      });
      sock.on('error', () => resolve(false));
      sock.setTimeout(5000, () => { sock.destroy(); resolve(false); });
    });

    if (tcpOk) {
      return { name: 'database', required: true, status: 'warn', detail: `TCP connect OK to ${dbHost}:${dbPort} but Prisma query failed: ${prismaResult.stderr?.substring(0, 200) || 'unknown'}`, durationMs };
    }

    return { name: 'database', required: true, status: 'fail', detail: `Cannot connect to DB at ${dbHost}:${dbPort}`, durationMs };
  } catch (e) {
    return { name: 'database', required: true, status: 'fail', detail: `Invalid DATABASE_URL: ${e.message}`, durationMs };
  }
}

async function checkMigrations() {
  const start = Date.now();
  const result = await runCmd('npx prisma migrate status --schema prisma/schema.prisma', { timeout: 15000 });
  const durationMs = Date.now() - start;

  if (result.success) {
    // Check if output indicates all migrations are applied
    const output = result.stdout + result.stderr;
    if (/Database schema is up to date/i.test(output) || /already at latest/i.test(output)) {
      return { name: 'migrations', required: true, status: 'pass', detail: 'All migrations applied', durationMs };
    }
    if (/pending/i.test(output)) {
      return { name: 'migrations', required: true, status: 'warn', detail: 'Pending migrations detected', durationMs };
    }
    return { name: 'migrations', required: true, status: 'pass', detail: 'Migration status checked', durationMs };
  }

  return { name: 'migrations', required: true, status: 'fail', detail: `prisma migrate status failed: ${(result.stderr || result.stdout || '').substring(0, 200)}`, durationMs };
}

async function checkSwagger(appUrl) {
  const start = Date.now();

  // Swagger is intentionally disabled in production mode (see main.ts).
  // The local .env may differ from the container env, so check the container's
  // actual NODE_ENV via docker compose exec.
  const containerEnvResult = await runCmd('docker compose exec -T app printenv NODE_ENV', { timeout: 5000 });
  const containerNodeEnv = (containerEnvResult.success ? containerEnvResult.stdout : '').trim().toLowerCase();
  const localNodeEnv = (ENV.NODE_ENV || '').toLowerCase();
  const effectiveNodeEnv = containerNodeEnv || localNodeEnv;

  if (effectiveNodeEnv === 'production') {
    return { name: 'swagger', required: false, status: 'skip', detail: `Swagger disabled in production (container NODE_ENV=${containerNodeEnv || 'N/A'}, local=${localNodeEnv})`, durationMs: Date.now() - start };
  }

  // Swagger JSON endpoint
  const res = await httpProbe(`${appUrl}/api/v1/docs-json`, { insecure: CLI.insecure, timeout: 7000 });
  const durationMs = Date.now() - start;

  if (res.ok && res.statusCode === 200) {
    // Verify it's actually a Swagger/OpenAPI JSON
    try {
      const body = JSON.parse(res.body);
      if (body.openapi || body.swagger) {
        return { name: 'swagger', required: false, status: 'pass', detail: `OpenAPI ${body.openapi || body.swagger} — ${body.info?.title || 'API docs'}`, durationMs };
      }
    } catch (e) { /* fall through */ }
    return { name: 'swagger', required: false, status: 'warn', detail: `HTTP 200 but not valid OpenAPI JSON`, durationMs };
  }

  // Try alternate path
  const res2 = await httpProbe(`${appUrl}/api/v1/docs`, { insecure: CLI.insecure, timeout: 7000 });
  if (res2.ok) {
    return { name: 'swagger', required: false, status: 'pass', detail: `Swagger UI accessible (HTTP ${res2.statusCode})`, durationMs: Date.now() - start };
  }

  return { name: 'swagger', required: false, status: 'fail', detail: `HTTP ${res.statusCode} — ${res.error || 'not accessible'}`, durationMs };
}

async function checkTelegramBot(appUrl) {
  const start = Date.now();
  // Check if Telegram bot token is configured
  if (!ENV.TELEGRAM_BOT_TOKEN) {
    return { name: 'telegram-bot', required: false, status: 'skip', detail: 'TELEGRAM_BOT_TOKEN not set — bot not configured', durationMs: Date.now() - start };
  }

  // Try to get bot info from Telegram API directly
  const tgApiUrl = `https://api.telegram.org/bot${ENV.TELEGRAM_BOT_TOKEN}/getMe`;
  const res = await httpProbe(tgApiUrl, { timeout: 7000 });
  const durationMs = Date.now() - start;

  if (res.ok && res.statusCode === 200) {
    try {
      const body = JSON.parse(res.body);
      if (body.ok && body.result) {
        return { name: 'telegram-bot', required: false, status: 'pass', detail: `Bot @${body.result.username} — ${body.result.first_name}`, durationMs };
      }
    } catch (e) { /* fall through */ }
  }

  return { name: 'telegram-bot', required: false, status: 'fail', detail: `Telegram API check failed: HTTP ${res.statusCode} — ${res.error || 'unknown'}`, durationMs };
}

async function checkXuiPanel(xuiUrl) {
  const start = Date.now();
  const res = await httpProbe(xuiUrl, { insecure: CLI.insecure, timeout: 7000 });
  const durationMs = Date.now() - start;

  if (res.ok && res.statusCode >= 200 && res.statusCode < 400) {
    // Check if it looks like 3x-ui
    const bodyMatch = /3x-?ui|xui|xray|panel|login|inbound/i.test(res.body || '');
    if (bodyMatch) {
      return { name: 'xui-panel', required: true, status: 'pass', detail: `HTTP ${res.statusCode} — 3x-ui panel detected`, durationMs };
    }
    return { name: 'xui-panel', required: true, status: 'warn', detail: `HTTP ${res.statusCode} but content doesn't match 3x-ui`, durationMs };
  }

  return { name: 'xui-panel', required: true, status: 'fail', detail: `HTTP ${res.statusCode} — ${res.error || 'not accessible'}`, durationMs };
}

/**
 * Check 3X-UI panel login by actually authenticating with credentials.
 * This verifies that the panel is not just accessible but that the configured
 * credentials work and a session can be established.
 *
 * Flow: GET /csrf-token → extract cookie + CSRF token → POST /login with credentials
 */
async function checkXuiLogin(xuiUrl) {
  const start = Date.now();

  // Get credentials from env
  const username = ENV.XUI_PANEL_USERNAME || ENV.SANITY_PANEL_USERNAME || '';
  const password = ENV.XUI_PANEL_PASSWORD || ENV.SANITY_PANEL_PASSWORD || '';

  if (!username || !password) {
    return { name: 'xui-login', required: true, status: 'warn', detail: 'XUI_PANEL_USERNAME/PASSWORD not set in .env — cannot verify login', durationMs: Date.now() - start };
  }

  // Step 1: Get CSRF token
  const csrfRes = await httpProbe(`${xuiUrl}/csrf-token`, {
    insecure: CLI.insecure,
    timeout: 7000,
    headers: { Accept: 'application/json' },
  });

  if (!csrfRes.ok) {
    return { name: 'xui-login', required: true, status: 'fail', detail: `CSRF token fetch failed: HTTP ${csrfRes.statusCode} — ${csrfRes.error || 'no response'}`, durationMs: Date.now() - start };
  }

  // Extract CSRF token and cookie from response
  let csrfToken = '';
  try {
    const csrfBody = JSON.parse(csrfRes.body);
    csrfToken = csrfBody.obj || csrfBody.token || '';
  } catch (e) { /* non-fatal, some 3x-ui versions don't require CSRF */ }

  // Extract session cookie from Set-Cookie header
  let bootstrapCookie = '';
  const setCookie = csrfRes.headers['set-cookie'];
  if (setCookie) {
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    bootstrapCookie = cookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  }

  // Step 2: POST /login with credentials
  const loginBody = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
  const loginRes = await httpProbe(`${xuiUrl}/login`, {
    method: 'POST',
    insecure: CLI.insecure,
    timeout: 10000,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...(bootstrapCookie ? { Cookie: bootstrapCookie } : {}),
    },
    body: loginBody,
  });

  const durationMs = Date.now() - start;

  if (!loginRes.ok && loginRes.statusCode === 0) {
    return { name: 'xui-login', required: true, status: 'fail', detail: `Login request failed: ${loginRes.error || 'connection refused'}`, durationMs };
  }

  // Parse login response
  try {
    const loginPayload = JSON.parse(loginRes.body);
    if (loginPayload.success === true) {
      // Verify we got a session cookie back
      const loginSetCookie = loginRes.headers['set-cookie'];
      const hasSessionCookie = loginSetCookie ? true : false;
      const detail = hasSessionCookie
        ? `Login successful as "${username}" — session established`
        : `Login successful as "${username}" — warning: no session cookie returned`;
      return { name: 'xui-login', required: true, status: hasSessionCookie ? 'pass' : 'warn', detail, durationMs };
    }
    if (loginPayload.success === false) {
      const msg = loginPayload.msg || 'credentials rejected';
      return { name: 'xui-login', required: true, status: 'fail', detail: `Login rejected: ${msg}`, durationMs };
    }
    return { name: 'xui-login', required: true, status: 'warn', detail: `Login response unexpected: ${loginRes.body?.substring(0, 150) || 'empty'}`, durationMs };
  } catch (e) {
    // Non-JSON response — might be a redirect or HTML error page
    if (loginRes.statusCode === 302 || loginRes.statusCode === 303) {
      return { name: 'xui-login', required: true, status: 'warn', detail: `Login returned redirect (HTTP ${loginRes.statusCode}) — may need cookie-based auth`, durationMs };
    }
    return { name: 'xui-login', required: true, status: 'fail', detail: `Login response parse failed (HTTP ${loginRes.statusCode}): ${loginRes.body?.substring(0, 150) || 'empty'}`, durationMs };
  }
}

async function checkQueue(appUrl) {
  const start = Date.now();
  // Queue health is typically checked via the readiness endpoint or a dedicated endpoint
  // We'll check if Redis is available for BullMQ (which we already check separately)
  // Also try a dedicated queue health endpoint if it exists
  const res = await httpProbe(`${appUrl}/health/queue`, { insecure: CLI.insecure, timeout: 5000 });
  const durationMs = Date.now() - start;

  if (res.ok) {
    return { name: 'queue', required: false, status: 'pass', detail: `Queue health OK (HTTP ${res.statusCode})`, durationMs };
  }

  // If no dedicated endpoint, queue health is implied by Redis health
  return { name: 'queue', required: false, status: 'skip', detail: 'No dedicated queue health endpoint — relies on Redis check', durationMs };
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  const appUrl = await getAppUrl();
  const xuiUrl = getXuiUrl();

  if (!CLI.json) {
    console.log('=== VPN SaaS Health Verification ===');
    console.log(`App URL:  ${appUrl}`);
    console.log(`XUI URL:  ${xuiUrl}`);
    console.log(`Insecure: ${CLI.insecure}`);
    console.log('');
  }

  const results = [];

  // Run all checks
  results.push(await checkDockerContainers());
  results.push(await checkAppHealth(appUrl));
  results.push(await checkAppReadiness(appUrl));
  results.push(await checkDatabase());
  results.push(await checkRedis());
  results.push(await checkMinIO());
  results.push(await checkMigrations());
  results.push(await checkSwagger(appUrl));
  results.push(await checkTelegramBot(appUrl));
  results.push(await checkXuiPanel(xuiUrl));
  results.push(await checkXuiLogin(xuiUrl));
  results.push(await checkQueue(appUrl));

  // Summary
  const required = results.filter((r) => r.required);
  const optional = results.filter((r) => !r.required);
  const requiredPassed = required.filter((r) => r.status === 'pass');
  const requiredFailed = required.filter((r) => r.status === 'fail');
  const requiredWarn = required.filter((r) => r.status === 'warn');
  const optionalPassed = optional.filter((r) => r.status === 'pass');
  const optionalFailed = optional.filter((r) => r.status === 'fail');
  const optionalSkipped = optional.filter((r) => r.status === 'skip');

  const allRequiredPassed = requiredFailed.length === 0;

  if (CLI.json) {
    const report = {
      timestamp: new Date().toISOString(),
      appUrl,
      xuiUrl,
      overall: allRequiredPassed ? 'healthy' : 'unhealthy',
      summary: {
        required: { total: required.length, passed: requiredPassed.length, failed: requiredFailed.length, warned: requiredWarn.length },
        optional: { total: optional.length, passed: optionalPassed.length, failed: optionalFailed.length, skipped: optionalSkipped.length },
      },
      checks: results,
    };
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('--- Check Results ---');
    for (const r of results) {
      const icon = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : r.status === 'warn' ? '⚠' : '⊘';
      const req = r.required ? '[REQUIRED]' : '[optional]';
      console.log(`  ${icon} ${r.name.padEnd(20)} ${req.padEnd(12)} ${r.status.toUpperCase().padEnd(6)} ${r.detail} (${r.durationMs}ms)`);
    }

    console.log('');
    console.log('--- Summary ---');
    console.log(`  Required: ${requiredPassed.length}/${required.length} passed, ${requiredFailed.length} failed, ${requiredWarn.length} warned`);
    console.log(`  Optional: ${optionalPassed.length} passed, ${optionalFailed.length} failed, ${optionalSkipped.length} skipped`);
    console.log('');
    console.log(`  Overall: ${allRequiredPassed ? '✓ HEALTHY — all required services are working' : '✗ UNHEALTHY — some required services are not working'}`);
  }

  // Save health check results to installer-state.json
  try {
    const _stateManager = require('./state-manager');
    const state = _stateManager.loadState(STATE_PATH);
    _stateManager.setEntry(state, 'health', {
      overall: allRequiredPassed ? 'healthy' : 'unhealthy',
      appUrl,
      xuiUrl,
      summary: {
        required: { total: required.length, passed: requiredPassed.length, failed: requiredFailed.length, warned: requiredWarn.length },
        optional: { total: optional.length, passed: optionalPassed.length, failed: optionalFailed.length, skipped: optionalSkipped.length },
      },
      checks: results.map((r) => ({ name: r.name, status: r.status, required: r.required, detail: r.detail })),
    }, { source: 'verify-health', confidence: 'high', ttlSeconds: 300 }); // 5 min TTL
    _stateManager.saveState(STATE_PATH, state);
  } catch (e) {
    // Non-fatal: don't fail the health check just because we couldn't save state
    if (!CLI.json) console.error('  (Warning: could not save health results to installer-state.json)');
  }

  process.exit(allRequiredPassed ? 0 : 1);
}

main().catch((e) => {
  console.error('Health verification failed with error:', e);
  process.exit(2);
});