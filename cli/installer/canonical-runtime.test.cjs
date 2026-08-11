'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path').posix;
const {
  deriveDiscoveryState,
  diagnosisFailureMessage,
  readCanonicalRuntime,
  resolveCanonicalPanel,
} = require('./canonical-runtime');

function fixture(files) {
  return {
    cwd: '/srv/tazaxy',
    path,
    fs: {
      existsSync: (file) => Object.hasOwn(files, file),
      readFileSync: (file) => files[file],
    },
  };
}

const config = {
  app: { publicIp: '203.0.113.7' },
  panel: {
    panelUrl: 'https://203.0.113.7:2443/panel/',
    subscriptionBaseUrl: 'https://203.0.113.7:2096',
    subscriptionPath: 'sub',
    subscriptionPort: 2096,
  },
};

test('native PostgreSQL route is discovered from the installer environment without a PostgreSQL container', () => {
  const runtime = readCanonicalRuntime(fixture({
    '/srv/tazaxy/.env': 'DATABASE_URL=postgresql://user:secret@172.28.0.1:5432/tazaxy?schema=public\n',
  }));
  assert.deepEqual(runtime.database, {
    configured: true, host: '172.28.0.1', port: 5432, database: 'tazaxy', source: 'environment',
  });
});

test('healthy containerized app promotes health while using a native database route', () => {
  const state = deriveDiscoveryState({ config, legacy: {}, database: { configured: true } }, {
    appContainerRunning: true,
    appContainerHealthy: true,
  });
  assert.equal(state.databaseDiscovered, true);
  assert.equal(state.healthChecked, true);
  assert.equal(state.healthOverall, 'healthy');
});

test('host-local XUI probes stay distinct from persisted container-reachable endpoints', () => {
  const panel = resolveCanonicalPanel(config, {
    data: {
      panel: { url: 'https://127.0.0.1:2443/panel/' },
      subscription: { scheme: 'https', host: '127.0.0.1', port: 2096, path: '/sub/' },
    },
  });
  assert.equal(panel.hostProbePanelUrl, 'https://127.0.0.1:2443/panel/');
  assert.equal(panel.panelUrl, config.panel.panelUrl);
  assert.equal(panel.subscriptionUrl, 'https://203.0.113.7:2096/sub/');
  assert.doesNotMatch(panel.panelUrl, /127\.0\.0\.1/);
});

test('fresh XUI port and paths override stale persisted values while preserving the reachable host', () => {
  const panel = resolveCanonicalPanel(config, {
    data: {
      panel: { url: 'https://127.0.0.1:8000/api/' },
      subscription: { scheme: 'https', host: '127.0.0.1', port: 2097, path: '/new-sub/' },
    },
  });
  assert.equal(panel.panelUrl, 'https://203.0.113.7:8000/api/');
  assert.equal(panel.subscriptionUrl, 'https://203.0.113.7:2097/new-sub/');
  assert.equal(panel.subscriptionPort, 2097);
  assert.equal(panel.subscriptionPath, 'new-sub');
});

test('persisted installer-authenticated XUI state remains verified for diagnosis', () => {
  const panel = resolveCanonicalPanel(config, {});
  assert.equal(panel.configured, true);
  assert.equal(panel.authenticated, true);
});

test('discovery summary does not report configured native PostgreSQL as missing', () => {
  const state = deriveDiscoveryState({ config, legacy: {}, database: { configured: true } }, {});
  assert.equal(state.databaseDiscovered, true);
  assert.equal(state.panelConfirmed, true);
});

test('a failed detector does not claim the running app container is unavailable', () => {
  const message = diagnosisFailureMessage(true, 'diagnostic command failed');
  assert.match(message, /container is running/);
  assert.doesNotMatch(message, /unavailable|not running/);
});
