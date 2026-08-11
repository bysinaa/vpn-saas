'use strict';

/**
 * Regression tests for the state-driven installation flow.
 *
 * The fixtures mirror the acceptance server exactly:
 *   3X-UI v3.6.0, HTTPS port 17342, base path /MTYFUStdaiG35FGCaU/,
 *   subscription port 2096, panel database /etc/x-ui/x-ui.db.
 *
 * Run with:  node --test cli/installer/installation-flow.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const posix = require('path').posix;

const { STATES, result } = require('./detection-states');
const { createXuiRuntimeDetector } = require('./xui-runtime-detector');
const { createTelegramDetector } = require('./telegram-detector');
const { createCleanInstaller } = require('./clean-install');
const { createInstallationFlow, STEPS } = require('./installation-flow');
const { createMenuNavigator, withNavigation, BACK, RETRY, REFRESH, EXIT } = require('./menu-navigator');
const { printVersion, isVersionRequest, readVersion } = require('./cli-version');

const PANEL_PORT = 17342;
const PANEL_BASE_PATH = '/MTYFUStdaiG35FGCaU/';
const SUB_PORT = 2096;
const PANEL_DB = '/etc/x-ui/x-ui.db';
const PANEL_URL = `https://127.0.0.1:${PANEL_PORT}${PANEL_BASE_PATH}`;
const PANEL_ROOT = `https://127.0.0.1:${PANEL_PORT}${PANEL_BASE_PATH.replace(/\/$/, '')}`;
const GOOD_PASSWORD = 'correct-horse';
const BOT_TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmno';

/** `x-ui setting -show true` output as printed by 3X-UI v3.6.0. */
const XUI_SETTINGS_OUTPUT = [
  'Panel is secure with SSL',
  `port: ${PANEL_PORT}`,
  'webBasePath: MTYFUStdaiG35FGCaU',
  'webCertFile: /root/cert/fullchain.pem',
  'webKeyFile: /root/cert/privkey.pem',
  `subPort: ${SUB_PORT}`,
  'subPath: /sub/',
  'subEnable: true',
  'hasDefaultCredential: false',
].join('\n');

const SS_OUTPUT = [
  'State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
  `LISTEN 0      4096         *:${PANEL_PORT}          *:*    users:(("x-ui",pid=811,fd=8))`,
  `LISTEN 0      4096         *:${SUB_PORT}           *:*    users:(("x-ui",pid=811,fd=9))`,
  'LISTEN 0      4096         *:5432           *:*    users:(("postgres",pid=712,fd=5))',
].join('\n');

/**
 * A scriptable stand-in for the host: exec, fs and HTTP are all recorded so a
 * test can assert on what the installer did *not* do as well as what it did.
 */
function createHost({ files = {}, commands = [], username = 'admin', password = GOOD_PASSWORD } = {}) {
  const execLog = [];
  const requestLog = [];
  const state = { files: { ...files }, cookieIssued: false };

  const defaultCommands = [
    [/systemctl is-active/, 'active'],
    [/setting -show true/, XUI_SETTINGS_OUTPUT],
    [/SELECT key, value FROM settings/, `webPort|${PANEL_PORT}\nwebBasePath|MTYFUStdaiG35FGCaU`],
    [/SELECT username FROM users/, username === null ? null : username],
    [/ss -ltnp/, SS_OUTPUT],
  ];
  const table = [...commands, ...defaultCommands];

  const runtime = {
    path: posix,
    cwd: () => '/opt/tazaxy',
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    exec: (command, options, callback) => {
      execLog.push(command);
      const entry = table.find(([pattern]) => pattern.test(command));
      const stdout = entry ? entry[1] : null;
      setImmediate(() =>
        stdout === null || stdout === undefined
          ? callback(new Error('exit status 1'), '', 'command failed')
          : callback(null, stdout, ''),
      );
    },
    fs: {
      existsSync: (file) => Object.prototype.hasOwnProperty.call(state.files, file),
      readFileSync: (file) => {
        if (!Object.prototype.hasOwnProperty.call(state.files, file)) throw new Error(`ENOENT: ${file}`);
        return state.files[file];
      },
      writeFileSync: (file, content) => {
        state.files[file] = content;
      },
      mkdirSync: () => undefined,
      copyFileSync: (from, to) => {
        state.files[to] = state.files[from];
      },
    },
    request: async (url, options = {}) => {
      requestLog.push({ url, options });
      if (/\/csrf-token$/.test(url)) {
        return { statusCode: 200, headers: { 'set-cookie': ['csrf=abc123; Path=/'] }, body: JSON.stringify({ success: true, obj: 'csrf-token-value' }) };
      }
      if (/\/login$/.test(url)) {
        const body = String(options.body || '');
        const accepted = body.includes(`password=${encodeURIComponent(password)}`) && body.includes(`username=${encodeURIComponent(username || 'admin')}`);
        if (!accepted) {
          // 3X-UI answers a rejected login with HTTP 200 and success:false.
          return { statusCode: 200, headers: {}, body: JSON.stringify({ success: false, msg: 'Invalid username or password' }) };
        }
        state.cookieIssued = true;
        return { statusCode: 200, headers: { 'set-cookie': ['3x-ui=session-value; Path=/; HttpOnly'] }, body: JSON.stringify({ success: true, msg: 'Login Successfully' }) };
      }
      if (/\/panel\/api\/inbounds\/list$/.test(url)) {
        if (!state.cookieIssued) return { statusCode: 401, headers: {}, body: '{"success":false}' };
        return { statusCode: 200, headers: {}, body: JSON.stringify({ success: true, obj: [{ id: 1 }, { id: 2 }, { id: 3 }] }) };
      }
      if (/api\.telegram\.org/.test(url)) {
        return /getMe/.test(url) && url.includes(BOT_TOKEN)
          ? { statusCode: 200, headers: {}, body: JSON.stringify({ ok: true, result: { id: 123456789, username: 'tazaxy_test_bot', first_name: 'Tazaxy', can_join_groups: true } }) }
          : { statusCode: 401, headers: {}, body: JSON.stringify({ ok: false, description: 'Unauthorized' }) };
      }
      return { statusCode: 404, headers: {}, body: '' };
    },
  };

  return { runtime, execLog, requestLog, state };
}

const PANEL_FILES = {
  '/etc/systemd/system/x-ui.service': '[Service]\nExecStart=/usr/local/x-ui/x-ui\nWorkingDirectory=/usr/local/x-ui\n',
  '/usr/local/x-ui/x-ui': 'binary',
  [PANEL_DB]: 'sqlite',
};

/** Environment detections are stubbed so panel/telegram behaviour is isolated. */
function createEnvironmentStub(overrides = {}) {
  const ok = (component, detail) => result(component, STATES.CONFIGURED, { detail });
  return {
    detectSystem: overrides.detectSystem || (async () => ok('system', 'Linux x86_64, running as root')),
    detectDocker: overrides.detectDocker || (async () => ok('docker', 'Docker 27.0 with Compose v2')),
    detectExistingInstallation: overrides.detectExistingInstallation || (async () => result('tazaxy', STATES.NOT_FOUND, { optional: true, detail: 'No previous installation' })),
    detectPostgres: overrides.detectPostgres || (async () => ok('postgres', 'PostgreSQL 16 reachable')),
    detectContainers: overrides.detectContainers || (async () => ok('containers', 'app, redis and minio running')),
    detectEnvFile: overrides.detectEnvFile || (async () => ok('env', '.env present')),
  };
}

function createFlowHarness({ host, environment = {}, prompts = {}, actions = {}, telegramConfigured = false } = {}) {
  const logs = [];
  const detectors = {
    environment: createEnvironmentStub({
      ...environment,
      ...(telegramConfigured ? {} : {}),
    }),
    xui: createXuiRuntimeDetector({ runtime: host.runtime }),
    telegram: createTelegramDetector({ runtime: host.runtime }),
    cleaner: createCleanInstaller({ runtime: host.runtime }),
  };
  const passing = async () => ({ state: STATES.CONFIGURED, detail: 'ok' });
  const flow = createInstallationFlow({
    runtime: host.runtime,
    detectors,
    prompts,
    logger: (message) => logs.push(String(message)),
    actions: { launcher: passing, infrastructure: passing, environment: passing, services: passing, health: passing, ...actions },
  });
  return { flow, logs, detectors };
}

test('discovery reads the existing 3X-UI runtime and never mutates it', async () => {
  const host = createHost({ files: PANEL_FILES });
  const detector = createXuiRuntimeDetector({ runtime: host.runtime });

  const detection = await detector.discover();

  assert.equal(detection.state, STATES.DETECTED);
  assert.equal(detection.data.panel.port, PANEL_PORT);
  assert.equal(detection.data.panel.webBasePath, PANEL_BASE_PATH);
  assert.equal(detection.data.panel.tls.enabled, true);
  assert.equal(detection.data.subscription.port, SUB_PORT);
  assert.equal(detection.data.database.path, PANEL_DB);
  assert.equal(detection.data.authentication.username, 'admin');
  assert.equal(detection.data.panel.listening, true, 'port 17342 must be observed as bound');
  assert.equal(detection.data.panel.url, PANEL_URL);

  // Nothing may install a panel, rewrite a setting or touch the subscription port.
  const mutating = host.execLog.filter((command) => /setting\s+-set|--port|install|systemctl (restart|stop)|x-ui@|update/i.test(command));
  assert.deepEqual(mutating, [], `discovery must be read-only, got: ${mutating.join(' | ')}`);
  assert.ok(!host.execLog.some((command) => command.includes(String(SUB_PORT)) && /set|write|update/i.test(command)));
});

test('authentication handles CSRF, session cookie and success:false, and only then reports CONNECTED', async () => {
  const host = createHost({ files: PANEL_FILES });
  const detector = createXuiRuntimeDetector({ runtime: host.runtime });
  const detection = await detector.discover();

  const rejected = await detector.authenticate(detection, { username: 'admin', password: 'wrong' });
  assert.equal(rejected.state, STATES.NEEDS_CREDENTIALS, 'success:false must not be read as authenticated');

  const connected = await detector.authenticate(detection, { username: 'admin', password: GOOD_PASSWORD });
  assert.equal(connected.state, STATES.CONNECTED);
  assert.equal(connected.data.inbounds, 3);

  const csrf = host.requestLog.find((entry) => /csrf-token$/.test(entry.url));
  const login = host.requestLog.find((entry) => /\/login$/.test(entry.url) && entry.options.headers['X-CSRF-Token']);
  const api = host.requestLog.find((entry) => /inbounds\/list$/.test(entry.url) && entry.options.headers.Cookie);
  assert.ok(csrf, 'a CSRF token must be minted before login');
  assert.ok(login, 'the login must carry the CSRF token');
  assert.match(api.options.headers.Cookie, /3x-ui=session-value/, 'the API probe must reuse the session cookie');
  assert.equal(api.options.insecure, true, 'a self-signed panel certificate must be tolerated');
  assert.ok(host.requestLog.every((entry) => entry.url.startsWith(PANEL_ROOT) || entry.url.includes('telegram')));
});

test('reachability alone never reports CONFIGURED or CONNECTED', async () => {
  const host = createHost({ files: PANEL_FILES });
  const detection = await createXuiRuntimeDetector({ runtime: host.runtime }).discover();
  assert.notEqual(detection.state, STATES.CONFIGURED);
  assert.notEqual(detection.state, STATES.CONNECTED);
});

test('the flow runs the required steps in the documented order', async () => {
  const host = createHost({ files: PANEL_FILES });
  const { flow } = createFlowHarness({
    host,
    prompts: {
      panelCredentials: async () => ({ username: 'admin', password: GOOD_PASSWORD }),
      telegramToken: async () => BOT_TOKEN,
    },
  });

  const outcome = await flow.run({ envPath: '/opt/tazaxy/.env' });

  assert.equal(outcome.ok, true, `flow failed at ${outcome.failedStep}: ${outcome.detail}`);
  assert.deepEqual(
    outcome.results.map((step) => step.key),
    ['preflight', 'detection', 'cleanup', 'launcher', 'infrastructure', 'panel', 'telegram', 'environment', 'services', 'health'],
  );
  // The order is a contract, not an accident.
  assert.deepEqual(STEPS.map((step) => step.key), outcome.results.map((step) => step.key));
});

test('an existing healthy panel is reused: no runtime preparation, no port change, no TLS/port/path questions', async () => {
  const host = createHost({ files: PANEL_FILES });
  const asked = [];
  const { flow, logs } = createFlowHarness({
    host,
    prompts: {
      panelCredentials: async (context) => {
        asked.push(context);
        return { username: 'admin', password: GOOD_PASSWORD };
      },
      telegramToken: async () => BOT_TOKEN,
    },
  });

  const outcome = await flow.run({ envPath: '/opt/tazaxy/.env' });
  const panel = outcome.results.find((step) => step.key === 'panel');
  const transcript = logs.join('\n');

  assert.equal(panel.state, STATES.CONNECTED);
  assert.match(transcript, /Reusing the existing 3X-UI installation/);
  assert.doesNotMatch(transcript, /Preparing 3X-UI runtime/i);
  assert.doesNotMatch(transcript, /TLS\?|certificate\?|base path\?|which port/i);
  assert.equal(outcome.snapshot.detections.xui.state, STATES.CONNECTED, 'the menu snapshot must show the verified panel');
  assert.equal(outcome.snapshot.detections.xui.data.panel.port, PANEL_PORT);

  // Reporting the detected subscription port is expected; *changing* it is not.
  // Assert on mutation, not on the mere appearance of the number.
  assert.match(transcript, /sub port 2096/, 'the detected subscription port is reported as-is');
  assert.doesNotMatch(transcript, /(chang|updat|set|remap|reassign|replac)\w*\s+(the\s+)?(sub\w*\s+)?port/i);
  assert.equal(outcome.snapshot.detections.xui.data.subscription.port, SUB_PORT, 'the subscription port survives untouched');
  const portMutations = host.execLog.filter((command) => /setting\s+-(set|port)|-port[= ]|webPort\s*=|subPort\s*=|UPDATE\s+settings/i.test(command));
  assert.deepEqual(portMutations, [], `no command may rewrite a panel port, got: ${portMutations.join(' | ')}`);
});

test('a panel with no readable username falls back to prompting and refreshes status at once', async () => {
  // username: null makes `SELECT username FROM users` fail, as on a locked-down host.
  const host = createHost({ files: PANEL_FILES, username: null });
  const refreshes = [];
  let prompted = 0;
  const { flow } = createFlowHarness({
    host,
    prompts: {
      panelCredentials: async () => {
        prompted += 1;
        // The first attempt is deliberately wrong to prove retries work.
        return prompted === 1 ? { username: 'admin', password: 'wrong' } : { username: 'admin', password: GOOD_PASSWORD };
      },
      telegramToken: async () => BOT_TOKEN,
    },
  });

  const discovery = await createXuiRuntimeDetector({ runtime: host.runtime }).discover();
  assert.equal(discovery.state, STATES.DETECTED, 'discovery remains useful without credentials');
  assert.ok(discovery.diagnostics.some((item) => item.code === 'AUTH_REQUIRED'));

  const outcome = await flow.run({ envPath: '/opt/tazaxy/.env', onRefresh: (snapshot) => refreshes.push(snapshot) });

  assert.equal(prompted, 2, 'the user is asked again after a rejected password');
  assert.equal(outcome.results.find((step) => step.key === 'panel').state, STATES.CONNECTED);
  assert.ok(refreshes.length >= 3, 'status must be refreshed immediately after credentials are accepted');
  assert.equal(refreshes[refreshes.length - 1].detections.xui.state, STATES.CONNECTED);
});

test('Telegram configuration is mandatory, validated with getMe, and the token is never printed', async () => {
  const host = createHost({ files: PANEL_FILES });
  const saved = [];
  let reloaded = 0;
  const { flow, logs } = createFlowHarness({
    host,
    prompts: {
      panelCredentials: async () => ({ username: 'admin', password: GOOD_PASSWORD }),
      // A malformed token, then a rejected token, then the valid one.
      telegramToken: (() => {
        const queue = ['not-a-token', '987654321:AAWrongTokenValueThatTelegramRejects1234', BOT_TOKEN];
        return async () => queue.shift();
      })(),
    },
    actions: {
      saveTelegramToken: async (token) => saved.push(token),
      reloadConfiguration: async () => {
        reloaded += 1;
      },
    },
  });

  const outcome = await flow.run({ envPath: '/opt/tazaxy/.env' });
  const telegram = outcome.results.find((step) => step.key === 'telegram');
  const transcript = logs.join('\n');

  assert.equal(telegram.state, STATES.CONNECTED);
  assert.equal(telegram.data.username, 'tazaxy_test_bot');
  assert.match(transcript, /@tazaxy_test_bot/, 'the bot username must be shown');
  assert.deepEqual(saved, [BOT_TOKEN], 'only a token accepted by getMe may be saved');
  assert.equal(reloaded, 1, 'configuration must be reloaded immediately');
  assert.ok(!transcript.includes(BOT_TOKEN), 'the token must never be printed');
  assert.ok(!transcript.includes('987654321:AAWrongTokenValue'), 'even a rejected token must not be printed');
});

test('a stored bot token that Telegram rejects is re-validated, not trusted', async () => {
  const host = createHost({ files: { ...PANEL_FILES, '/opt/tazaxy/.env': 'TELEGRAM_BOT_TOKEN=555555555:AAStaleTokenThatIsNoLongerValid000000\n' } });
  const saved = [];
  const { flow } = createFlowHarness({
    host,
    prompts: {
      panelCredentials: async () => ({ username: 'admin', password: GOOD_PASSWORD }),
      telegramToken: async () => BOT_TOKEN,
    },
    actions: {
      readTelegramToken: async () => '555555555:AAStaleTokenThatIsNoLongerValid000000',
      saveTelegramToken: async (token) => saved.push(token),
    },
  });

  const outcome = await flow.run({ envPath: '/opt/tazaxy/.env' });

  assert.equal(outcome.results.find((step) => step.key === 'telegram').state, STATES.CONNECTED);
  assert.deepEqual(saved, [BOT_TOKEN], 'the stale token must be replaced, never reported as connected');
});

test('a failed optional detection does not terminate the installation', async () => {
  const host = createHost({ files: PANEL_FILES });
  const { flow } = createFlowHarness({
    host,
    environment: {
      detectContainers: async () => {
        throw new Error('docker socket unavailable');
      },
    },
    prompts: {
      panelCredentials: async () => ({ username: 'admin', password: GOOD_PASSWORD }),
      telegramToken: async () => BOT_TOKEN,
    },
  });

  const outcome = await flow.run({ envPath: '/opt/tazaxy/.env' });

  assert.equal(outcome.ok, true, 'an optional component must not abort the flow');
  assert.equal(outcome.snapshot.detections.containers.state, STATES.FAILED);
  assert.match(outcome.snapshot.detections.containers.recovery, /Retry/);
});

test('a failed required step reports the exact step and a recovery action', async () => {
  const host = createHost({ files: PANEL_FILES });
  const { flow } = createFlowHarness({
    host,
    actions: {
      infrastructure: async () => ({ state: STATES.FAILED, detail: 'PostgreSQL refused the connection', recovery: 'Start PostgreSQL, then retry Infrastructure.' }),
    },
    prompts: { telegramToken: async () => BOT_TOKEN },
  });

  const outcome = await flow.run({ envPath: '/opt/tazaxy/.env' });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.failedStep, 'infrastructure');
  assert.equal(outcome.detail, 'PostgreSQL refused the connection');
  assert.match(outcome.recovery, /Start PostgreSQL/);
  // Later steps must not have run.
  assert.equal(outcome.results.some((step) => step.key === 'services'), false);
});

test('clean install removes only Tazaxy resources and preserves 3X-UI and unrelated data', async () => {
  const host = createHost({
    files: { ...PANEL_FILES, '/opt/tazaxy': 'dir', '/usr/local/bin/tazaxy': 'launcher', '/opt/tazaxy/.env': 'A=1', '/opt/tazaxy/installer-state.json': '{}' },
    commands: [
      [/docker ps -a --format/, 'tazaxy-app\ntazaxy-redis\ncustomer-nginx\nx-ui'],
      [/docker network ls --format/, 'tazaxy_default\nbridge'],
      [/docker volume ls --filter label=com\.tazaxy\.managed=true/, 'tazaxy_pgdata'],
      [/docker volume ls$/, 'tazaxy_pgdata\nimportant-user-data'],
      [/systemctl is-enabled tazaxy/, 'enabled'],
    ],
  });
  const cleaner = createCleanInstaller({ runtime: host.runtime });

  const plan = await cleaner.plan({ workspace: '/opt/tazaxy' });
  const outcome = await cleaner.execute({ workspace: '/opt/tazaxy', plan, dryRun: true });
  const commands = outcome.executed.map((entry) => entry.command).join('\n');

  assert.deepEqual(plan.containers, ['tazaxy-app', 'tazaxy-redis']);
  assert.deepEqual(plan.networks, ['tazaxy_default']);
  assert.deepEqual(plan.volumes, ['tazaxy_pgdata']);
  assert.ok(!commands.includes('customer-nginx'), 'unrelated containers must be preserved');
  assert.ok(!commands.includes('important-user-data'), 'unlabelled volumes must be preserved');
  assert.ok(!/x-ui/.test(commands), '3X-UI must never be touched');
  assert.ok(!commands.includes(PANEL_DB), 'the panel database must never be removed');
  assert.match(commands, /rm -rf "\/opt\/tazaxy"/);
  assert.match(commands, /rm -rf "\/usr\/local\/bin\/tazaxy"/);
  assert.deepEqual(outcome.backup.saved, ['.env', 'installer-state.json'], 'the .env and state must be backed up first');
});

test('clean install refuses to remove a protected 3X-UI path even if it is planned', async () => {
  const host = createHost({ files: { '/etc/x-ui': 'dir', [PANEL_DB]: 'sqlite' } });
  const cleaner = createCleanInstaller({ runtime: host.runtime });

  const outcome = await cleaner.execute({
    workspace: '/opt/tazaxy',
    skipBackup: true,
    dryRun: true,
    plan: { paths: ['/etc/x-ui', PANEL_DB, '/opt/tazaxy'], containers: [], networks: [], volumes: [], services: [] },
  });

  const removed = outcome.executed.map((entry) => entry.command).join('\n');
  assert.ok(!removed.includes('/etc/x-ui'), 'the protected path guard must hold');
  assert.match(removed, /rm -rf "\/opt\/tazaxy"/);
});

test('every submenu offers Back, Retry and Refresh; only the root menu can exit', () => {
  const submenu = withNavigation([{ value: 'a', label: 'A' }]).map((item) => item.value);
  const root = withNavigation([{ value: 'a', label: 'A' }], { root: true }).map((item) => item.value);

  assert.deepEqual(submenu, ['a', REFRESH, RETRY, BACK]);
  assert.deepEqual(root, ['a', REFRESH, RETRY, EXIT]);
  assert.ok(!submenu.includes(EXIT), 'a submenu must not offer Exit');
});

test('returning from a submenu does not exit the installer, and status refreshes after every change', async () => {
  let refreshCount = 0;
  const snapshotFor = (state) => ({ components: [{ key: 'xui', label: '3X-UI panel', state }], detections: {} });
  let panelState = STATES.DETECTED;
  const answers = ['panel', 'boom', RETRY, BACK, REFRESH, EXIT];
  const logs = [];

  const navigator = createMenuNavigator({
    logger: (message) => logs.push(String(message)),
    refresh: async () => {
      refreshCount += 1;
      return snapshotFor(panelState);
    },
    prompt: async () => answers.shift(),
  });

  const submenu = {
    key: 'panel-menu',
    title: 'Panel',
    items: [{ value: 'boom', label: 'Break something' }],
    handler: async (action) => {
      if (action === 'boom') throw new Error('panel unreachable');
      return undefined;
    },
  };

  const outcome = await navigator.open({
    key: 'root',
    root: true,
    title: 'Tazaxy Installer',
    items: [{ value: 'panel', label: 'Panel' }],
    handler: async (action, context) => {
      if (action === 'panel') {
        panelState = STATES.CONNECTED; // a change made inside the submenu
        return context.open(submenu);
      }
      return undefined;
    },
  });

  const transcript = logs.join('\n');
  assert.equal(outcome, EXIT, 'the installer exits only from the root Exit entry');
  assert.equal(navigator.depth, 0, 'the menu stack must unwind cleanly');
  assert.match(transcript, /Step "boom" failed: panel unreachable/);
  assert.match(transcript, /Recovery/);
  assert.ok(refreshCount >= 4, 'status is re-derived after each action');
  assert.match(transcript, /CONNECTED/, 'the header must show the change made in the submenu');
  assert.equal(answers.length, 0, 'every scripted answer must be consumed');
});

test('Retry with no previous action is reported rather than crashing', async () => {
  const answers = [RETRY, EXIT];
  const logs = [];
  const navigator = createMenuNavigator({
    logger: (message) => logs.push(String(message)),
    refresh: async () => ({ components: [], detections: {} }),
    prompt: async () => answers.shift(),
  });

  const outcome = await navigator.open({ root: true, title: 'Root', items: [], handler: async () => undefined });

  assert.equal(outcome, EXIT);
  assert.match(logs.join('\n'), /no previous action to retry/i);
});

test('tazaxy --version prints only the version and exits 0', () => {
  const written = [];
  const code = printVersion({ argv: ['--version'], write: (line) => written.push(line), readFileSync: () => '{"version":"2.0.0"}' });

  assert.equal(code, 0, '--version must exit 0');
  assert.deepEqual(written, ['2.0.0\n'], 'nothing but the version may be written');
  assert.equal(printVersion({ argv: ['-v'], write: () => {}, readFileSync: () => '{"version":"2.0.0"}' }), 0);
  assert.equal(printVersion({ argv: ['version'], write: () => {}, readFileSync: () => '{"version":"2.0.0"}' }), 0);
});

// Found on a host where api.telegram.org resolved to a black-hole address and
// refused the connection: the detector reported NEEDS_CREDENTIALS, which tells
// the operator to re-type a token that was never actually checked.
test('an unreachable Telegram API is FAILED, not a rejected token', async () => {
  const attempts = [];
  const detector = createTelegramDetector({
    runtime: {
      request: async (url) => {
        attempts.push(url);
        return { statusCode: 0, headers: {}, body: '', error: 'connect ECONNREFUSED 10.10.34.35:443' };
      },
    },
  });

  const outcome = await detector.validateToken(BOT_TOKEN);

  assert.equal(outcome.state, STATES.FAILED, 'a blocked network must not be reported as a credential problem');
  assert.notEqual(outcome.state, STATES.NEEDS_CREDENTIALS);
  assert.equal(outcome.data.reachable, false);
  assert.match(outcome.detail, /could not reach api\.telegram\.org/i);
  assert.match(outcome.recovery, /token was not checked/i, 'the operator must be told the token was never checked');
  assert.equal(attempts.length, 1);
  assert.ok(!JSON.stringify(outcome).includes(BOT_TOKEN), 'the token must never appear in the result');
});

test('Telegram 5xx is FAILED while a real rejection stays NEEDS_CREDENTIALS', async () => {
  const serverError = await createTelegramDetector({
    runtime: { request: async () => ({ statusCode: 502, headers: {}, body: '<html>bad gateway</html>' }) },
  }).validateToken(BOT_TOKEN);

  assert.equal(serverError.state, STATES.FAILED, 'a Telegram-side outage is not the operator\'s fault');
  assert.match(serverError.detail, /502/);

  const rejected = await createTelegramDetector({
    runtime: {
      request: async () => ({ statusCode: 401, headers: {}, body: JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }) }),
    },
  }).validateToken(BOT_TOKEN);

  assert.equal(rejected.state, STATES.NEEDS_CREDENTIALS, 'only Telegram actually rejecting the token asks for a new one');
  assert.match(rejected.recovery, /BotFather/);
  assert.ok(!JSON.stringify(rejected).includes(BOT_TOKEN));
});

test('version handling ignores other commands and survives an unreadable package.json', () => {

  assert.equal(printVersion({ argv: ['install'], write: () => assert.fail('must not print') }), null);
  assert.equal(isVersionRequest(['panel', '--version']), false, '--version after a command is a command option');
  assert.equal(
    readVersion({
      readFileSync: () => {
        throw new Error('ENOENT');
      },
    }),
    '0.0.0',
  );
  assert.match(readVersion(), /^\d+\.\d+\.\d+/, 'the real package.json must expose a semver version');
});
