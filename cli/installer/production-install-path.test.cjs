'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

test('the built production install path discovers existing 3X-UI before asking only for its password', async () => {
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'cli/tsconfig.json'], { cwd: ROOT });
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'copy-cli-assets.cjs')], { cwd: ROOT });

  const launcher = fs.readFileSync(path.join(ROOT, 'scripts', 'install.sh'), 'utf8');
  const entry = fs.readFileSync(path.join(ROOT, 'cli', 'dist-cli', 'index.js'), 'utf8');
  const installCommand = fs.readFileSync(path.join(ROOT, 'cli', 'dist-cli', 'commands', 'install.3xui.js'), 'utf8');
  assert.match(launcher, /node cli\/dist-cli\/index\.js install "\$@"/);
  assert.match(entry, /commands\/install\.3xui/);
  assert.match(installCommand, /createXuiRuntimeDetector/);
  assert.match(installCommand, /createPostgresDetector/);
  assert.doesNotMatch(installCommand, /@postgres:5432/);

  const detectorPath = require.resolve(path.join(ROOT, 'cli', 'dist-cli', 'installer', 'xui-runtime-detector.js'));
  const prompts = [];
  let authInput;
  const detection = {
    state: 'DETECTED',
    data: {
      installation: { kind: 'native', service: { workingDirectory: '/usr/local/x-ui' } },
      panel: { url: 'https://203.0.113.5:17342/panel-root/', port: 17342, webBasePath: '/panel-root/', tls: { enabled: true } },
      subscription: { scheme: 'http', host: '203.0.113.5', port: 2096, path: '/subscription-root/' },
      authentication: { username: 'existing-admin' },
    },
  };
  require(detectorPath);
  require.cache[detectorPath].exports = {
    createXuiRuntimeDetector: () => ({
      discover: async () => detection,
      authenticate: async (_detection, credentials) => {
        authInput = credentials;
        return { ...detection, state: 'CONNECTED' };
      },
    }),
  };

  const commandPath = require.resolve(path.join(ROOT, 'cli', 'dist-cli', 'commands', 'install.3xui.js'));
  delete require.cache[commandPath];
  const { InstallCommand } = require(commandPath);
  class TestCommand extends InstallCommand {
    section() {}
    log() {}
    async prompt(question) { prompts.push(question); throw new Error(`unexpected prompt: ${question}`); }
    async promptRequired(question) { prompts.push(question); throw new Error(`unexpected prompt: ${question}`); }
    async promptSecret(question) { prompts.push(question); return 'real-password'; }
    async confirm(question) { prompts.push(question); throw new Error(`unexpected legacy prompt: ${question}`); }
    async findAvailablePort() { throw new Error('legacy port guessing executed'); }
    async execCommand(command) { throw new Error(`unexpected legacy command: ${command}`); }
    async execOrThrow(command) { throw new Error(`existing panel must not be installed again: ${command}`); }
    async saveRuntimeConfig(updater) {
      const saved = await updater({ superAdmins: [], paths: {} });
      assert.equal(saved.panel.panelPass, undefined, 'plaintext credential must not enter installer state');
      return saved;
    }
  }

  const runtime = await new TestCommand().ensure3xuiRuntime({}, '203.0.113.5');
  assert.deepEqual(authInput, { username: 'existing-admin', password: 'real-password' });
  assert.deepEqual(prompts, ['3X-UI admin password']);
  assert.equal(runtime.panelUrl, 'https://203.0.113.5:17342/panel-root/');
  assert.equal(runtime.subscriptionBaseUrl, 'http://203.0.113.5:2096');
  assert.equal(runtime.subscriptionPath, 'subscription-root');
  assert.equal(runtime.subscriptionPort, 2096);
  assert.equal(runtime.panelPass, 'real-password', 'validated credential remains in memory for reconciliation');
});

test('production execute creates the app network before database environment provisioning and compose up', async () => {
  const commandPath = require.resolve(path.join(ROOT, 'cli', 'dist-cli', 'commands', 'install.3xui.js'));
  const { InstallCommand } = require(commandPath);
  const calls = [];
  const panel = {};
  class OrderingCommand extends InstallCommand {
    setExecutionMode() {}
    section() {}
    log() {}
    async detectLinuxPlatform() { return { distro: 'ubuntu', family: 'debian', architecture: 'x86_64' }; }
    async validatePlatform() {}
    async ensureRootPrivileges() {}
    async detectPublicIp() { return '203.0.113.1'; }
    async findAvailablePort(port) { return port; }
    async saveRuntimeConfig() {}
    async ensureDockerInstalled() {}
    async ensureDockerComposeInstalled() {}
    async ensureBasePackages() {}
    async ensureDatabaseNetwork() { calls.push('network'); return { name: 'tazaxy-network', subnet: '172.31.0.0/16', gateway: '172.31.0.1', bridge: 'br-current' }; }
    async configureFirewall() {}
    async ensure3xuiRuntime() { return panel; }
    async ensureEnvironmentWizard(_options, _ip, _port, _panel, network) {
      calls.push(`database:${network.gateway}`);
    }
    async buildAndStartContainers() { calls.push('compose-up'); }
    async runPrismaTasks() {}
    async reconcileXuiRuntime() {}
    async ensureSuperAdmin() {}
    async validateInstallation() {}
    async showFinalSummary() {}
  }

  await new OrderingCommand().execute({});
  assert.deepEqual(calls, ['network', 'database:172.31.0.1', 'compose-up']);
});

test('production compose startup reconciles stale owned containers after build and before up', async () => {
  const commandPath = require.resolve(path.join(ROOT, 'cli', 'dist-cli', 'commands', 'install.3xui.js'));
  delete require.cache[commandPath];
  const { InstallCommand } = require(commandPath);
  const calls = [];
  class ComposeStart extends InstallCommand {
    section() {}
    log() {}
    async execOrThrow(command) { calls.push(command.includes('build') ? 'build' : command.includes('up -d') ? 'up' : command); }
    async reconcileStaleComposeContainers() { calls.push('reconcile'); return { removed: ['tazaxy-minio-1'] }; }
  }

  await new ComposeStart().buildAndStartContainers();
  assert.deepEqual(calls, ['build', 'reconcile', 'up']);
  const built = fs.readFileSync(commandPath, 'utf8');
  assert.match(built, /createComposeLifecycle/);
  assert.doesNotMatch(built, /docker compose --env-file/);
});

test('final installer validation fails closed unless every service, app probe, migration, and XUI diagnosis passes', async () => {
  const commandPath = require.resolve(path.join(ROOT, 'cli', 'dist-cli', 'commands', 'install.3xui.js'));
  delete require.cache[commandPath];
  const { InstallCommand } = require(commandPath);
  const panel = {
    panelUrl: 'https://203.0.113.7:2443/panel/',
    subscriptionBaseUrl: 'https://203.0.113.7:2096',
    subscriptionPort: 2096,
    subscriptionPath: 'sub',
  };
  const healthyServices = ['app', 'redis', 'minio', 'nginx']
    .map((Service) => JSON.stringify({ Service, State: 'running', Health: 'healthy' }))
    .join('\n');

  class ValidInstall extends InstallCommand {
    section() {}
    log() {}
    async execCommand(command) {
      if (command.includes('ps --format json')) return { ok: true, stdout: healthyServices, stderr: '' };
      if (command.includes('/health/ready')) return { ok: true, stdout: '{"status":"ok","checks":{"database":{"status":"up"}}}', stderr: '' };
      if (command.includes('/health')) return { ok: true, stdout: '{"status":"ok"}', stderr: '' };
      if (command.includes('prisma migrate status')) return { ok: true, stdout: 'Database schema is up to date!', stderr: '' };
      throw new Error(`unexpected command: ${command}`);
    }
    async execWithInput(command, input) {
      assert.match(command, /dist\/src\/scripts\/diagnose-xui\.js/);
      const observation = JSON.parse(input);
      assert.equal(observation.baseUrl, panel.panelUrl);
      assert.equal(observation.subPort, 2096);
      assert.equal(observation.subPath, 'sub');
      assert.equal(observation.source, 'installer-authenticated');
      assert.equal(observation.listenerCoherent, true);
      assert.ok(!Number.isNaN(Date.parse(observation.observedAt)));
      return { ok: true, stdout: JSON.stringify({ state: 'CONNECTED', applicationConnectivity: true, apiProbe: true }), stderr: '' };
    }
  }
  await new ValidInstall().validateInstallation(panel);

  class UnhealthyInstall extends ValidInstall {
    async execCommand(command) {
      const result = await super.execCommand(command);
      if (command.includes('ps --format json')) result.stdout = result.stdout.replace('"Service":"minio","State":"running","Health":"healthy"', '"Service":"minio","State":"running","Health":"unhealthy"');
      return result;
    }
  }
  await assert.rejects(() => new UnhealthyInstall().validateInstallation(panel), /minio is not running and healthy/);
});

test('Linux command timeouts terminate the spawned command tree, not only its shell', () => {
  const command = fs.readFileSync(path.join(ROOT, 'cli', 'dist-cli', 'commands', 'install.interface.js'), 'utf8');
  assert.match(command, /detached: process\.platform !== 'win32'/);
  assert.match(command, /process\.kill\(-child\.pid, 'SIGTERM'\)/);
});

test('installer rejects a super-admin password that the production app cannot start with', async () => {
  const commandPath = require.resolve(path.join(ROOT, 'cli', 'dist-cli', 'commands', 'install.3xui.js'));
  delete require.cache[commandPath];
  const { InstallCommand } = require(commandPath);
  const answers = ['short', 'long-enough'];
  const warnings = [];
  class PasswordValidation extends InstallCommand {
    async promptSecret() { return answers.shift(); }
    log(message) { warnings.push(message); }
  }

  assert.equal(await new PasswordValidation().promptSecretWithMinLength('Super admin password', 8), 'long-enough');
  assert.match(warnings.join('\n'), /at least 8 characters/);
});

test('installer rejects a bot token accidentally entered as the super-admin Telegram ID', async () => {
  const commandPath = require.resolve(path.join(ROOT, 'cli', 'dist-cli', 'commands', 'install.3xui.js'));
  delete require.cache[commandPath];
  const { InstallCommand } = require(commandPath);
  const answers = ['123456:bot-token', '1133720502'];
  const warnings = [];
  class TelegramIdValidation extends InstallCommand {
    async promptRequired() { return answers.shift(); }
    log(message) { warnings.push(message); }
  }

  assert.equal(await new TelegramIdValidation().promptForValidTelegramId(), '1133720502');
  assert.match(warnings.join('\n'), /digits only/);
});

test('healthy application reports its native PostgreSQL route online from app context', async () => {
  const commandPath = require.resolve(path.join(ROOT, 'cli', 'dist-cli', 'commands', 'status.js'));
  delete require.cache[commandPath];
  const { StatusCommand } = require(commandPath);
  class HealthyStatus extends StatusCommand {
    async execCommand(command) {
      assert.match(command, /exec -T app .*health\/ready/);
      return { ok: true, stdout: '{"status":"ok","checks":{"database":{"status":"up"}}}', stderr: '' };
    }
  }
  const result = await new HealthyStatus().checkDatabase();
  assert.equal(result.status, 'online');
  assert.match(result.summary, /application container/);
});

test('status checks Redis in its container and never treats inactive as active', async () => {
  const commandPath = require.resolve(path.join(ROOT, 'cli', 'dist-cli', 'commands', 'status.js'));
  delete require.cache[commandPath];
  const { StatusCommand } = require(commandPath);
  class RedisStatus extends StatusCommand {
    async execCommand(command) {
      assert.match(command, /exec -T redis redis-cli ping/);
      return { ok: false, stdout: 'inactive', stderr: '' };
    }
  }
  const result = await new RedisStatus().checkRedis();
  assert.notEqual(result.status, 'online');
});

test('informational listener occupancy does not make an otherwise healthy status fail', async () => {
  const commandPath = require.resolve(path.join(ROOT, 'cli', 'dist-cli', 'commands', 'status.js'));
  delete require.cache[commandPath];
  const { StatusCommand } = require(commandPath);
  const output = [];
  const originalLog = console.log;
  console.log = (line = '') => output.push(String(line));
  class HealthyStatus extends StatusCommand {
    section() {}
    log(message) { output.push(message); }
    async loadRuntimeConfig() { return {}; }
    async reconcileXuiDrift() {}
    async checkDocker() { return { name: 'Docker', status: 'online', summary: 'ok' }; }
    async checkCompose() { return { name: 'Docker Compose', status: 'online', summary: 'ok' }; }
    async check3xui() { return { name: '3X-UI', status: 'online', summary: 'ok' }; }
    async checkDatabase() { return { name: 'PostgreSQL', status: 'online', summary: 'ok' }; }
    async checkRedis() { return { name: 'Redis', status: 'online', summary: 'ok' }; }
    async checkApplication() { return { name: 'TAZAXY Application', status: 'online', summary: 'ok' }; }
    async checkConfiguredPorts() { return { name: 'Listener Occupancy', status: 'unknown', summary: 'informational' }; }
  }
  try { await new HealthyStatus().execute({}); } finally { console.log = originalLog; }
  assert.match(output.join('\n'), /6\/6 required checks passing/);
  assert.match(output.join('\n'), /Platform health checks passed/);
});

test('panel diagnosis sends persisted reachable XUI state and does not blame a running app for detector failure', async () => {
  const detectorPath = require.resolve(path.join(ROOT, 'cli', 'dist-cli', 'installer', 'xui-runtime-detector.js'));
  require(detectorPath);
  require.cache[detectorPath].exports = {
    createXuiRuntimeDetector: () => ({
      discover: async () => ({
        data: {
          installation: { kind: 'native' },
          panel: { url: 'https://127.0.0.1:2443/panel/', listening: true },
          subscription: { scheme: 'https', host: '127.0.0.1', port: 2096, path: '/sub/', listening: true },
          database: { backend: 'sqlite', path: '/etc/x-ui/x-ui.db' },
          diagnostics: [],
        },
      }),
    }),
  };
  const commandPath = require.resolve(path.join(ROOT, 'cli', 'dist-cli', 'commands', 'panel.js'));
  delete require.cache[commandPath];
  const { PanelCommand } = require(commandPath);
  let payload;
  const logs = [];
  const output = [];
  const originalLog = console.log;
  console.log = (line) => output.push(String(line));
  class DiagnosingPanel extends PanelCommand {
    async loadRuntimeConfig() {
      return {
        app: { publicIp: '203.0.113.7' },
        panel: {
          panelUrl: 'https://203.0.113.7:2443/panel/',
          subscriptionBaseUrl: 'https://203.0.113.7:2096',
          subscriptionPath: 'sub',
          subscriptionPort: 2096,
        },
      };
    }
    async execWithInput(_command, input) { payload = JSON.parse(input); return { ok: false, stdout: '', stderr: 'diagnostic probe failed' }; }
    async execCommand() { return { ok: true, stdout: 'app\n', stderr: '' }; }
    log(message) { logs.push(message); }
  }
  try {
    await new DiagnosingPanel().diagnosePanel();
  } finally {
    console.log = originalLog;
  }
  assert.equal(payload.baseUrl, 'https://203.0.113.7:2443/panel/');
  assert.doesNotMatch(JSON.stringify(payload), /127\.0\.0\.1/);
  assert.ok(output.includes('Authentication: INSTALLER_VERIFIED'));
  assert.match(logs.join('\n'), /container is running/);
  assert.doesNotMatch(logs.join('\n'), /unavailable|not running/);
});

test('panel diagnosis executes the packaged canonical diagnostic and parses its result', async () => {
  const commandPath = require.resolve(path.join(ROOT, 'cli', 'dist-cli', 'commands', 'panel.js'));
  delete require.cache[commandPath];
  const { PanelCommand } = require(commandPath);
  let command;
  let payload;
  const output = [];
  const originalLog = console.log;
  console.log = (line) => output.push(String(line));
  class SuccessfulDiagnosis extends PanelCommand {
    async loadRuntimeConfig() {
      return {
        panel: {
          panelUrl: 'https://203.0.113.7:2443/panel/',
          subscriptionBaseUrl: 'https://203.0.113.7:2096',
          subscriptionPath: 'sub',
          subscriptionPort: 2096,
        },
      };
    }
    async execWithInput(value, input) {
      command = value;
      payload = JSON.parse(input);
      return {
        ok: true,
        stderr: '',
        stdout: JSON.stringify({
          authentication: 'AUTHENTICATED', apiProbe: true,
          inbounds: { discovered: 2, enabled: 2, eligible: 1 },
          reconciliation: { vpnPanel: true, serverCount: 1, inboundConfigCount: 2 },
          applicationConnectivity: true,
          drift: { classification: 'UNCHANGED' },
          panel: { healthStatus: 'HEALTHY', syncStatus: 'SYNCED' },
          state: 'CONNECTED',
        }),
      };
    }
    log() {}
  }
  try {
    await new SuccessfulDiagnosis().diagnosePanel();
  } finally {
    console.log = originalLog;
  }

  assert.match(command, /exec -T app node dist\/src\/scripts\/diagnose-xui\.js/);
  assert.equal(payload.baseUrl, 'https://203.0.113.7:2443/panel/');
  assert.equal(payload.subPort, 2096);
  assert.ok(output.includes('Connection state: CONNECTED'));
  assert.ok(output.includes('Application-context connectivity: PASS'));
});

test('pre-created installer network is reused by compose and survives compose down', (t) => {
  const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
  const available = spawnSync(docker, ['info'], { encoding: 'utf8' });
  if (available.status !== 0) return t.skip('Docker daemon unavailable');

  const production = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
  const networkBlock = production.match(/networks:\s*\r?\n([\s\S]*?)(?=\r?\n\r?\nvolumes:)/)?.[1] || '';
  assert.match(networkBlock, /tazaxy-network:\s*\r?\n\s+external:\s*true\s*\r?\n\s+name:\s*tazaxy-network/);
  assert.doesNotMatch(networkBlock, /\bdriver:|\bipam:/, 'Compose must not duplicate installer-owned network configuration');

  const network = 'tazaxy-network';
  const existed = spawnSync(docker, ['network', 'inspect', network], { stdio: 'ignore' }).status === 0;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tazaxy-external-network-'));
  const composeFile = path.join(scratch, 'compose.yml');
  const project = `tazaxy-network-regression-${process.pid}`;
  fs.writeFileSync(composeFile, [
    'services:',
    '  probe:',
    '    image: redis:7-alpine',
    "    command: ['sh', '-c', 'sleep 30']",
    '    networks: [tazaxy-network]',
    'networks:',
    '  tazaxy-network:',
    '    external: true',
    '    name: tazaxy-network',
    '',
  ].join('\n'));

  try {
    if (!existed) execFileSync(docker, ['network', 'create', network], { stdio: 'pipe' });
    execFileSync(docker, ['compose', '-p', project, '-f', composeFile, 'up', '-d'], { stdio: 'pipe' });
    execFileSync(docker, ['compose', '-p', project, '-f', composeFile, 'down'], { stdio: 'pipe' });
    assert.equal(spawnSync(docker, ['network', 'inspect', network], { stdio: 'ignore' }).status, 0);
  } finally {
    spawnSync(docker, ['compose', '-p', project, '-f', composeFile, 'down'], { stdio: 'ignore' });
    if (!existed) spawnSync(docker, ['network', 'rm', network], { stdio: 'ignore' });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
