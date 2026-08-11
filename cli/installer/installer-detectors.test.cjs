'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createXuiCredentialValidator } = require('./xui-credential-validator');
const { createPostgresDetector } = require('./postgres-detector');
const { createInstallerAdapter } = require('./installer-adapter');
const { createXuiRuntimeDetector } = require('./xui-runtime-detector');


function fixtureRuntime({ files = {}, commands = {}, request = async () => ({ statusCode: 404, headers: {}, body: '' }) } = {}) {
  const writes = [];
  return {
    writes,
    cwd: () => '/fixture',
    path: require('path').posix,
    fs: { existsSync: (name) => Object.hasOwn(files, name), readFileSync: (name) => files[name], writeFileSync: (...args) => writes.push(args) },
    exec: (command, _options, done) => { const value = commands[command] || { error: new Error('missing-fixture'), stdout: '', stderr: '' }; done(value.error || null, value.stdout || '', value.stderr || ''); },
    request,
    now: () => new Date('2026-08-03T00:00:00.000Z'),
  };
}

const quietCommands = { 'docker ps --format "{{.Names}}||{{.Image}}||{{.Ports}}"': { stdout: '' }, 'docker compose ps --format "{{.Name}}||{{.Image}}||{{.Publishers}}"': { stdout: '' }, 'systemctl list-units --type=service --all --no-legend': { stdout: '' }, 'ps -eo pid,args': { stdout: '' }, 'ps -eo args': { stdout: '' }, 'wsl.exe -e sh -lc "ps -eo args"': { stdout: '' } };

/**
 * Emulates 3x-ui v3.6.0 as observed on a live panel: a CSRF token must be minted
 * and echoed on unsafe methods, and a *failed* login is HTTP 200 + {"success":false}.
 * Returning a bare 200 here would let a broken validator pass, which is exactly
 * how an earlier regression slipped through.
 */
function xuiPanelFixture({ password = 'secret', requireCsrf = true } = {}) {
  return async (url, options = {}) => {
    if (url.endsWith('/csrf-token')) return { statusCode: 200, headers: { 'set-cookie': ['3x-ui=session-value; Path=/'] }, body: '{"success":true,"obj":"csrf-abc"}' };
    if (url.endsWith('/login')) {
      if (requireCsrf && options.headers?.['X-CSRF-Token'] !== 'csrf-abc') return { statusCode: 403, headers: {}, body: '' };
      const supplied = new URLSearchParams(options.body || '').get('password');
      return { statusCode: 200, headers: { 'set-cookie': ['3x-ui=session-value; Path=/'] }, body: supplied === password ? '{"success":true}' : '{"success":false,"msg":"Invalid username or password"}' };
    }
    if (url.endsWith('/panel/api/inbounds/list')) return { statusCode: 200, headers: {}, body: '{"success":true,"obj":[]}' };
    return { statusCode: 404, headers: {}, body: '' };
  };
}


test('XUI Docker discovery uses container metadata without treating it as authentication', async () => {
  const runtime = fixtureRuntime({ commands: { 'systemctl is-active x-ui 2>/dev/null || systemctl is-active 3x-ui 2>/dev/null': { stdout: '' }, 'ss -ltnp 2>/dev/null; ss -lunp 2>/dev/null || netstat -ltnp 2>/dev/null': { stdout: '' }, 'docker ps --format "{{.Names}}||{{.Image}}||{{.Ports}}"': { stdout: 'xui||mhsanaei/3x-ui||0.0.0.0:2053->2053/tcp, 0.0.0.0:2096->2096/tcp' } } });
  const detection = await createXuiRuntimeDetector({ runtime }).discover();
  assert.equal(detection.state, 'DETECTED'); assert.equal(detection.data.installation.kind, 'docker'); assert.equal(detection.data.panel.port, 2053); assert.equal(detection.data.subscription.port, 2096); assert.ok(detection.diagnostics.some((item) => item.code === 'AUTH_REQUIRED')); assert.equal(runtime.writes.length, 0);
});

test('XUI credential validation never exposes credentials and failed validation never persists', async () => {
  let persisted = false;
  const validator = createXuiCredentialValidator({ runtime: fixtureRuntime({ request: async () => ({ statusCode: 401, headers: {}, body: 'invalid password' }) }) });
  const result = await validator.validate({ connection: { url: 'http://xui.test' }, username: 'admin', password: 'secret', onValidated: async () => { persisted = true; } });
  assert.equal(result.status, 'ERROR'); assert.equal(persisted, false); assert.ok(!JSON.stringify(result).includes('secret'));
});

test('XUI validator can use an existing encrypted credential only in memory', async () => {
  const validator = createXuiCredentialValidator({ runtime: fixtureRuntime({ request: xuiPanelFixture({ password: 'encrypted-secret' }) }) });
  const result = await validator.validateExistingEncrypted({ connection: { url: 'http://xui.test' }, loadEncryptedCredential: async () => ({ username: 'admin', password: 'encrypted-secret' }) });
  assert.equal(result.status, 'FOUND'); assert.ok(!JSON.stringify(result).includes('encrypted-secret'));
});

test('XUI validator sends a CSRF token and rejects a wrong password answered with HTTP 200', async () => {
  const validator = createXuiCredentialValidator({ runtime: fixtureRuntime({ request: xuiPanelFixture({ password: 'right-password' }) }) });
  assert.equal((await validator.validate({ connection: { url: 'http://xui.test' }, username: 'admin', password: 'right-password' })).status, 'FOUND');
  // The panel answers a bad login with HTTP 200, so a status-code-only check would wrongly accept it.
  const rejected = await validator.validate({ connection: { url: 'http://xui.test' }, username: 'admin', password: 'wrong-password' });
  assert.equal(rejected.status, 'ERROR'); assert.equal(rejected.diagnostics[0].code, 'AUTH_FAILED');
});

test('successful XUI credential validation invokes encrypted persistence adapter and reuses binding', async () => {
  const validator = createXuiCredentialValidator({ runtime: fixtureRuntime({ request: xuiPanelFixture({ password: 'secret' }) }) });
  const writes = []; let bindings = 0; let syncs = 0;
  const adapter = createInstallerAdapter({ loadState: () => ({}), saveState: (state) => writes.push(state), encrypt: () => 'ENC:fixture' });
  const detection = { status: 'FOUND', source: 'docker', connection: { url: 'http://xui.test', scheme: 'http', host: 'xui.test', port: 80, webBasePath: '' } };
  const validation = await validator.validate({ connection: detection.connection, username: 'admin', password: 'secret', onValidated: ({ username, password }) => adapter.registerValidatedPanel({ detection, username, password, registerPanel: async (input) => ({ id: 7, credential: input.encryptedCredential }), ensureBinding: async () => { bindings += 1; return { id: 9, reused: bindings > 1 }; }, syncInbounds: async () => { syncs += 1; return { count: 2 }; } }) });
  assert.equal(validation.status, 'FOUND'); assert.equal(writes.length, 1); assert.equal(bindings, 1); assert.equal(syncs, 1); assert.ok(!JSON.stringify(writes).includes('secret'));
});

test('installer adapter persists the same sanitized discovery result idempotently', async () => {
  const writes = []; const state = {};
  const adapter = createInstallerAdapter({ loadState: () => state, saveState: (next) => writes.push(next) });
  const result = { status: 'FOUND', source: 'docker', connection: { host: 'xui.test', port: 2053 } };
  await adapter.persistDetection('xui', result);
  await adapter.persistDetection('xui', result);
  assert.equal(writes.length, 1);
  assert.ok(!JSON.stringify(writes).match(/password|secret|token/i));
});

test('PostgreSQL Docker, Compose, native and WSL fixtures report sanitized connection metadata', async () => {
  const commands = { ...quietCommands, 'docker ps --format "{{.Names}}||{{.Image}}||{{.Ports}}"': { stdout: 'pg||postgres:16||0.0.0.0:5544->5432/tcp' }, 'docker compose ps --format "{{.Name}}||{{.Image}}||{{.Publishers}}"': { stdout: 'pg||postgres:16||' }, 'systemctl list-units --type=service --all --no-legend': { stdout: 'postgresql.service loaded active' }, 'ps -eo args': { stdout: 'postgres' }, 'wsl.exe -e sh -lc "ps -eo args"': { stdout: 'postgres' }, 'pg_isready -h 127.0.0.1 -p 5544 -d postgres': { stdout: '127.0.0.1:5544 - accepting connections' }, 'pg_isready -h 127.0.0.1 -p 5432 -d postgres': { stdout: '127.0.0.1:5432 - accepting connections' } };
  const result = await createPostgresDetector({ runtime: fixtureRuntime({ commands }) }).discover();
  assert.equal(result.status, 'FOUND'); assert.equal(result.connection.port, 5544); assert.ok(!JSON.stringify(result).includes('postgresql://'));
});

test('PostgreSQL configured datasource, unavailable pg_isready, unreachable and malformed config stay redacted', async () => {
  const runtime = fixtureRuntime({ files: { '/fixture/.env': 'DATABASE_URL=postgresql://alice:secret@db.test:5433/tazaxy\nBAD_DATABASE_URL=oops\n' }, commands: { ...quietCommands, 'pg_isready -h db.test -p 5433 -d tazaxy': { error: new Error('not found') } } });
  const result = await createPostgresDetector({ runtime }).discover();
  assert.equal(result.status, 'PARTIAL'); assert.deepEqual(result.connection, { host: 'db.test', port: 5433, database: 'tazaxy' }); assert.ok(!JSON.stringify(result).includes('secret'));
});

test('PostgreSQL authentication validation exposes no password or URL', async () => {
  const detector = createPostgresDetector({ runtime: fixtureRuntime() });
  const result = await detector.validateAuthentication({ candidate: { connection: { host: 'db', port: 5432, database: 'tazaxy' } }, username: 'alice', password: 'secret', validate: async () => false });
  assert.equal(result.status, 'ERROR'); assert.ok(!JSON.stringify(result).includes('secret'));
});

/**
 * Reproduces the acceptance host (3x-ui v3.6.0, HTTPS 17342, base path
 * /MTYFUStdaiG35FGCaU/): the settings table carries no `subPort` row because the
 * operator never moved the subscription port off the 2096 default, yet x-ui is
 * demonstrably bound to it. Reading settings alone reported "sub port n/a".
 */
function livePanelRuntime({ settings, listening }) {
  const dbPath = '/etc/x-ui/x-ui.db';
  const rows = JSON.stringify(settings);
  const runtime = fixtureRuntime({
    files: { [dbPath]: '', '/etc/systemd/system/x-ui.service': 'ExecStart=/usr/local/x-ui/x-ui\n' },
    commands: {},
  });
  // The live host ships no sqlite3 CLI, so only the python3 fallback answers.
  runtime.exec = (command, _options, done) => {
    if (command.includes('systemctl is-active')) return done(null, 'active', '');
    if (command.startsWith('sqlite3 ')) return done(new Error('sqlite3: not found'), '', '');
    if (command.includes('SELECT key, value FROM settings')) return done(null, rows, '');
    if (command.includes('SELECT username FROM users')) return done(null, 'admin', '');
    if (command.includes('ss -ltnp')) return done(null, listening, '');
    return done(new Error('missing-fixture'), '', '');
  };
  return runtime;
}

const LIVE_LISTENING = [
  'State Recv-Q Send-Q Local Address:Port Peer Address:PortProcess',
  'LISTEN 0 4096 *:17342 *:* users:(("x-ui",pid=421796,fd=11))',
  'LISTEN 0 4096 *:2096 *:* users:(("x-ui",pid=421796,fd=12))',
].join('\n');

test('XUI runtime detector infers the stock 2096 subscription port when no subPort row exists', async () => {
  const runtime = livePanelRuntime({
    settings: { webPort: '17342', webBasePath: '/MTYFUStdaiG35FGCaU/', webCertFile: '/root/cert/ip/fullchain.pem', webKeyFile: '/root/cert/ip/privkey.pem' },
    listening: LIVE_LISTENING,
  });
  const detection = await createXuiRuntimeDetector({ runtime }).discover();

  assert.equal(detection.state, 'DETECTED');
  assert.equal(detection.data.panel.port, 17342);
  assert.equal(detection.data.panel.webBasePath, '/MTYFUStdaiG35FGCaU/');
  assert.equal(detection.data.panel.tls.enabled, true);
  assert.equal(detection.data.panel.url, 'https://127.0.0.1:17342/MTYFUStdaiG35FGCaU/');
  // The regression: 2096 is bound by x-ui, so it must not be reported as absent.
  assert.equal(detection.data.subscription.port, 2096);
  assert.equal(detection.data.subscription.portSource, 'default-bound');
  assert.equal(detection.data.subscription.enabled, true);
  assert.ok(!detection.detail.includes('n/a'));
});

test('XUI runtime detector prefers an explicit subPort over the bound default', async () => {
  const runtime = livePanelRuntime({
    settings: { webPort: '17342', webBasePath: '/MTYFUStdaiG35FGCaU/', subPort: '8443', subEnable: 'true' },
    listening: LIVE_LISTENING,
  });
  const detection = await createXuiRuntimeDetector({ runtime }).discover();
  assert.equal(detection.data.subscription.port, 8443);
  assert.equal(detection.data.subscription.portSource, 'settings');
});

test('XUI keeps panel and subscription ports and paths distinct, with honest diagnostics', async () => {
  const runtime = livePanelRuntime({
    settings: { webPort: '2053', webBasePath: '/abc/', webDomain: 'panel.example.test', subPort: '2096', subPath: '/sub/', subDomain: 'sub.example.test', webCertFile: '/cert.pem' },
    listening: 'LISTEN 0 4096 *:2053 *:* users:(("nginx",pid=1,fd=1))',
  });
  const detection = await createXuiRuntimeDetector({ runtime }).discover();
  assert.deepEqual({ port: detection.data.panel.port, path: detection.data.panel.webBasePath }, { port: 2053, path: '/abc/' });
  assert.deepEqual({ port: detection.data.subscription.port, path: detection.data.subscription.path }, { port: 2096, path: '/sub/' });
  assert.equal(detection.data.panel.host, 'panel.example.test');
  assert.equal(detection.data.subscription.host, 'sub.example.test');
  assert.equal(detection.data.panel.scheme, 'https');
  assert.equal(detection.data.subscription.scheme, 'http');
  assert.ok(detection.diagnostics.some((item) => item.code === 'SUBSCRIPTION_PORT_NOT_LISTENING'));
  assert.ok(detection.diagnostics.some((item) => item.code === 'PORT_OWNED_BY_DIFFERENT_PROCESS'));
  assert.equal(detection.data.authentication.state, 'AUTH_REQUIRED');
});

test('XUI runtime detector reports no subscription port when 2096 is not bound', async () => {
  const runtime = livePanelRuntime({
    settings: { webPort: '17342' },
    listening: 'LISTEN 0 4096 *:17342 *:* users:(("x-ui",pid=421796,fd=11))',
  });
  const detection = await createXuiRuntimeDetector({ runtime }).discover();
  assert.equal(detection.data.subscription.port, null);
  assert.equal(detection.data.subscription.portSource, 'unknown');
  assert.equal(detection.data.subscription.enabled, undefined);
});

test('XUI malformed settings and an absent install degrade with diagnostics, never CONNECTED', async () => {
  const malformed = await createXuiRuntimeDetector({ runtime: livePanelRuntime({ settings: { webPort: 'not-a-port', subPort: 'also-bad' }, listening: '' }) }).discover();
  assert.equal(malformed.state, 'DETECTED');
  assert.ok(malformed.diagnostics.some((item) => item.code === 'PANEL_PORT_UNKNOWN'));
  const missing = await createXuiRuntimeDetector({ runtime: fixtureRuntime({ commands: { 'systemctl is-active x-ui 2>/dev/null || systemctl is-active 3x-ui 2>/dev/null': { stdout: '' }, 'ss -ltnp 2>/dev/null; ss -lunp 2>/dev/null || netstat -ltnp 2>/dev/null': { stdout: '' }, 'docker ps --format "{{.Names}}||{{.Image}}||{{.Ports}}"': { stdout: '' } } }) }).discover();
  assert.equal(missing.state, 'NOT_FOUND'); assert.ok(missing.diagnostics.some((item) => item.code === 'XUI_NOT_FOUND'));
});

test('XUI runtime discovery never reports CONNECTED without authentication', async () => {
  const runtime = livePanelRuntime({ settings: { webPort: '17342', webBasePath: '/MTYFUStdaiG35FGCaU/' }, listening: LIVE_LISTENING });
  const detection = await createXuiRuntimeDetector({ runtime }).discover();
  // Service detection alone must never be promoted past DETECTED.
  assert.notEqual(detection.state, 'CONNECTED');
  assert.notEqual(detection.state, 'CONFIGURED');
});
