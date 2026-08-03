'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createXuiDetector } = require('./xui-detector');
const { createXuiCredentialValidator } = require('./xui-credential-validator');
const { createPostgresDetector } = require('./postgres-detector');
const { createInstallerAdapter } = require('./installer-adapter');

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

test('XUI Docker fixture discovers mhsanaei/3x-ui on port 2053 without writes', async () => {
  const runtime = fixtureRuntime({ commands: { ...quietCommands, 'docker ps --format "{{.Names}}||{{.Image}}||{{.Ports}}"': { stdout: 'xui||mhsanaei/3x-ui||0.0.0.0:2053->2053/tcp' } }, request: async () => ({ statusCode: 200, headers: {}, body: '<title>3x-ui login</title>' }) });
  const result = await createXuiDetector({ runtime }).discover();
  assert.equal(result.status, 'FOUND'); assert.equal(result.connection.port, 2053); assert.equal(runtime.writes.length, 0);
});

test('XUI SQLite fixture honors custom port and web path while redacting unrelated settings', async () => {
  const runtime = fixtureRuntime({ files: { '/etc/3x-ui/3x-ui.db': '' }, commands: quietCommands, request: async () => ({ statusCode: 401, headers: {}, body: 'login required' }) });
  runtime.readSqliteSettings = async () => ({ webPort: '9443', webDomain: 'panel.test', webPath: 'secret-panel', adminPassword: 'must-not-leak' });
  const result = await createXuiDetector({ runtime }).discover();
  assert.equal(result.connection.url, 'http://panel.test:9443/secret-panel'); assert.equal(JSON.stringify(result), JSON.stringify(result).replace(/must-not-leak/g, ''));
});

test('XUI Compose, systemd, process and WSL fixtures produce deduplicated safe candidates', async () => {
  const runtime = fixtureRuntime({ commands: { ...quietCommands, 'docker compose ps --format "{{.Name}}||{{.Image}}||{{.Publishers}}"': { stdout: 'xui||mhsanaei/3x-ui||0.0.0.0:2053->2053/tcp' }, 'systemctl list-units --type=service --all --no-legend': { stdout: 'x-ui.service loaded active running' }, 'ps -eo pid,args': { stdout: '1 /usr/local/x-ui/x-ui' }, 'wsl.exe -e sh -lc "ps -eo args"': { stdout: 'x-ui' } }, request: async () => ({ statusCode: 200, headers: {}, body: 'x-ui login' }) });
  const result = await createXuiDetector({ runtime }).discover();
  assert.equal(result.status, 'FOUND'); assert.equal(new Set(result.candidates.map((item) => item.connection.url)).size, result.candidates.length);
});

test('XUI absent, timeout, wrong service and malformed response fixtures are not false positives', async () => {
  for (const request of [async () => ({ statusCode: 0, error: 'request-timeout', headers: {}, body: '' }), async () => ({ statusCode: 200, headers: {}, body: '<h1>nginx</h1>' }), async () => ({ statusCode: 200, headers: {}, body: '{not-json' })]) {
    const result = await createXuiDetector({ runtime: fixtureRuntime({ commands: quietCommands, request }) }).discover({ baseUrl: 'http://127.0.0.1:2053' });
    assert.notEqual(result.status, 'FOUND');
  }
});

test('XUI TLS errors require explicit request-scoped insecure mode', async () => {
  const calls = [];
  const runtime = fixtureRuntime({ commands: quietCommands, request: async (_url, options) => { calls.push(options.insecure); return options.insecure ? { statusCode: 200, headers: {}, body: '3x-ui login' } : { statusCode: 0, error: 'self signed certificate', headers: {}, body: '' }; } });
  const detector = createXuiDetector({ runtime });
  assert.notEqual((await detector.discover({ baseUrl: 'https://panel.test' })).status, 'FOUND');
  assert.equal((await detector.discover({ baseUrl: 'https://panel.test', insecure: true })).status, 'FOUND');
  assert.deepEqual(calls, [false, true]);
});

test('XUI credential validation never exposes credentials and failed validation never persists', async () => {
  let persisted = false;
  const validator = createXuiCredentialValidator({ runtime: fixtureRuntime({ request: async () => ({ statusCode: 401, headers: {}, body: 'invalid password' }) }) });
  const result = await validator.validate({ connection: { url: 'http://xui.test' }, username: 'admin', password: 'secret', onValidated: async () => { persisted = true; } });
  assert.equal(result.status, 'ERROR'); assert.equal(persisted, false); assert.ok(!JSON.stringify(result).includes('secret'));
});

test('XUI validator can use an existing encrypted credential only in memory', async () => {
  const validator = createXuiCredentialValidator({ runtime: fixtureRuntime({ request: async (url) => url.endsWith('/login') ? ({ statusCode: 200, headers: {}, body: 'ok' }) : ({ statusCode: 200, headers: {}, body: '{}' }) }) });
  const result = await validator.validateExistingEncrypted({ connection: { url: 'http://xui.test' }, loadEncryptedCredential: async () => ({ username: 'admin', password: 'encrypted-secret' }) });
  assert.equal(result.status, 'FOUND'); assert.ok(!JSON.stringify(result).includes('encrypted-secret'));
});

test('successful XUI credential validation invokes encrypted persistence adapter and reuses binding', async () => {
  const validator = createXuiCredentialValidator({ runtime: fixtureRuntime({ request: async (url) => url.endsWith('/login') ? ({ statusCode: 200, headers: {}, body: '{"success":true}' }) : ({ statusCode: 200, headers: {}, body: '{"success":true}' }) }) });
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
