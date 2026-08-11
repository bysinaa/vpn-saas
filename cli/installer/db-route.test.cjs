'use strict';

/**
 * Regression tests for the native-host PostgreSQL + Dockerised app route.
 *
 * The bug: the installer wrote `127.0.0.1:5432` into DATABASE_URL. That address
 * is correct on the host and meaningless inside the app container, so the app
 * failed with TCP_FAILURE and restart-looped forever.
 *
 * These tests pin the behaviour that prevents it. Fixtures mirror the real
 * server: native PostgreSQL on 5432 listening on localhost only, app/Redis/MinIO
 * in Docker on tazaxy-network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyDeployment,
  resolveAppDatabaseHost,
  buildDatabaseUrl,
  buildHostAuthRule,
  buildListenAddresses,
  isLoopback,
  DEFAULT_SUBNET,
  DEFAULT_GATEWAY,
} = require('./db-route-resolver');
const { createDbConnectivityVerifier } = require('./db-connectivity-verifier');

// ── Fixture: the acceptance server ────────────────────────────────
const NATIVE_PG = { host: '127.0.0.1', port: 5432, source: 'systemd:postgresql', containerName: null };
const DOCKER_PG = { host: '127.0.0.1', port: 5432, source: 'docker:compose', containerName: 'tazaxy-postgres' };

/** Fake docker CLI. `reach` decides whether the probe container gets through. */
function dockerRuntime({
  subnet = DEFAULT_SUBNET,
  gateway = DEFAULT_GATEWAY,
  networkId = 'ffd9ce2a170c1234567890',
  bridge,
  networkExists = true,
  reach = true,
  auth = true,
} = {}) {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args].join(' '));
    if (args[0] === 'network' && args[1] === 'inspect') {
      return networkExists
        ? {
            ok: true,
            code: 0,
            stdout: JSON.stringify({
              Id: networkId,
              Driver: 'bridge',
              Options: bridge ? { 'com.docker.network.bridge.name': bridge } : {},
              IPAM: { Config: [{ Subnet: subnet, Gateway: gateway }] },
            }),
            stderr: '',
          }
        : { ok: false, code: 1, stdout: '', stderr: 'No such network' };
    }
    if (args.includes('pg_isready')) {
      return reach
        ? { ok: true, code: 0, stdout: 'accepting connections', stderr: '' }
        : { ok: false, code: 2, stdout: '', stderr: 'no response' };
    }
    if (args.includes('psql')) {
      return auth
        ? { ok: true, code: 0, stdout: '1', stderr: '' }
        : { ok: false, code: 2, stdout: '', stderr: 'FATAL: password authentication failed, password=hunter2' };
    }
    return { ok: false, code: 127, stdout: '', stderr: 'unexpected' };
  };
  return { runtime: { run }, calls };
}

// ── The actual bug ────────────────────────────────────────────────

test('native PostgreSQL + Docker app never gets a loopback address', () => {
  const route = resolveAppDatabaseHost({
    detectedHost: '127.0.0.1',
    deployment: classifyDeployment(NATIVE_PG),
    appInDocker: true,
    gateway: DEFAULT_GATEWAY,
  });
  assert.equal(isLoopback(route.host), false, 'a container must never be told to dial 127.0.0.1');
  assert.equal(route.host, DEFAULT_GATEWAY);
  assert.equal(route.route, 'bridge-gateway');
});

test('buildDatabaseUrl refuses a loopback host for a containerised app', () => {
  assert.throws(
    () =>
      buildDatabaseUrl({
        user: 'tazaxy', password: 'p', host: '127.0.0.1', port: 5432, database: 'tazaxy', appInDocker: true,
      }),
    /refusing to write DATABASE_URL host/,
    'the exact URL that caused the restart loop must not be constructible',
  );
  // localhost is the same mistake spelled differently.
  assert.throws(
    () => buildDatabaseUrl({ user: 'u', host: 'localhost', port: 5432, database: 'd', appInDocker: true }),
    /refusing to write DATABASE_URL host/,
  );
});

test('generated URL points at the gateway and keeps credentials intact', () => {
  const route = resolveAppDatabaseHost({
    detectedHost: '127.0.0.1', deployment: 'native-host', appInDocker: true, gateway: DEFAULT_GATEWAY,
  });
  const url = buildDatabaseUrl({
    user: 'tazaxy', password: 'p@ss/word', host: route.host, port: 5432, database: 'tazaxy', appInDocker: true,
  });
  assert.match(url, /^postgresql:\/\/tazaxy:p%40ss%2Fword@172\.28\.0\.1:5432\/tazaxy\?schema=public$/);
  assert.doesNotMatch(url, /127\.0\.0\.1|localhost/);
});

// ── Cases that must keep working ──────────────────────────────────

test('app on the host keeps the loopback address', () => {
  const route = resolveAppDatabaseHost({ detectedHost: '127.0.0.1', deployment: 'native-host', appInDocker: false });
  assert.equal(route.host, '127.0.0.1');
  assert.equal(route.route, 'host-local');
  // And the URL builder must not object when the consumer really is the host.
  const url = buildDatabaseUrl({ user: 'u', host: route.host, port: 5432, database: 'd', appInDocker: false });
  assert.match(url, /127\.0\.0\.1/);
});

test('containerised PostgreSQL is reached by container name, not the gateway', () => {
  const route = resolveAppDatabaseHost({
    detectedHost: '127.0.0.1',
    deployment: classifyDeployment(DOCKER_PG),
    appInDocker: true,
    containerName: 'tazaxy-postgres',
    gateway: DEFAULT_GATEWAY,
  });
  assert.equal(route.host, 'tazaxy-postgres');
  assert.equal(route.route, 'docker-network');
});

test('an already-routable address is preserved, not replaced by the gateway', () => {
  const route = resolveAppDatabaseHost({
    detectedHost: '10.0.0.5', deployment: 'unknown', appInDocker: true, gateway: DEFAULT_GATEWAY,
  });
  assert.equal(route.host, '10.0.0.5');
  assert.equal(route.route, 'explicit-host');
});

test('deployment classification separates native from containerised', () => {
  assert.equal(classifyDeployment(NATIVE_PG), 'native-host');
  assert.equal(classifyDeployment(DOCKER_PG), 'docker');
  assert.equal(classifyDeployment({ source: 'unknown' }), 'unknown');
});

// ── Access must stay private ──────────────────────────────────────

test('pg_hba rule authorises only the Tazaxy subnet, never the public internet', () => {
  const rule = buildHostAuthRule({ database: 'tazaxy', user: 'tazaxy', subnet: DEFAULT_SUBNET });
  assert.match(rule, /^host\s+tazaxy\s+tazaxy\s+172\.28\.0\.0\/16\s+scram-sha-256$/);
  assert.throws(
    () => buildHostAuthRule({ database: 'tazaxy', user: 'tazaxy', subnet: '0.0.0.0/0' }),
    /that is public access/,
    'opening the database to the world must be impossible, not merely discouraged',
  );
});

test('listen_addresses adds the gateway but never becomes a wildcard', () => {
  const value = buildListenAddresses({ gateway: DEFAULT_GATEWAY, existing: 'localhost' });
  assert.equal(value, 'localhost,172.28.0.1');
  assert.doesNotMatch(value, /\*/);
  // A pre-existing wildcard is narrowed, not preserved.
  assert.doesNotMatch(buildListenAddresses({ gateway: DEFAULT_GATEWAY, existing: '*' }), /\*/);
});

// ── Verification happens from the app network ─────────────────────

test('probe runs inside the app network, not on the host', async () => {
  const { runtime, calls } = dockerRuntime();
  const verifier = createDbConnectivityVerifier({ runtime });
  await verifier.verify({ detection: NATIVE_PG, user: 'tazaxy', password: 'p', database: 'tazaxy' });

  const probes = calls.filter((c) => c.includes('docker run'));
  assert.ok(probes.length >= 2, 'expected a TCP probe and an auth probe');
  for (const call of probes) {
    assert.match(call, /--network tazaxy-network/, 'probing from the host would prove nothing');
  }
});

test('reachable + authenticated is CONNECTED', async () => {
  const { runtime } = dockerRuntime({ reach: true, auth: true });
  const out = await createDbConnectivityVerifier({ runtime }).verify({
    detection: NATIVE_PG, user: 'tazaxy', password: 'p', database: 'tazaxy',
  });
  assert.equal(out.state.state, 'CONNECTED');
  assert.equal(out.route.host, DEFAULT_GATEWAY);
});

test('unreachable is DETECTED/unreachable — never CONFIGURED, so the app stays stopped', async () => {
  const { runtime } = dockerRuntime({ reach: false });
  const out = await createDbConnectivityVerifier({ runtime }).verify({
    detection: NATIVE_PG, user: 'tazaxy', password: 'p', database: 'tazaxy',
  });
  assert.equal(out.state.state, 'DETECTED');
  assert.equal(out.state.data.unreachable, true);
  assert.match(out.state.detail, /UNREACHABLE/);
  assert.notEqual(out.state.state, 'CONFIGURED');
  assert.notEqual(out.state.state, 'CONNECTED');
  // The operator gets the two exact edits, not "check your configuration".
  assert.equal(out.remediation.length, 2);
  assert.match(out.remediation[0], /listen_addresses = 'localhost,172\.28\.0\.1'/);
  assert.match(out.remediation[1], /172\.28\.0\.0\/16/);
});

test('TCP works but login fails is NEEDS_CREDENTIALS, and no password leaks', async () => {
  const { runtime } = dockerRuntime({ reach: true, auth: false });
  const out = await createDbConnectivityVerifier({ runtime }).verify({
    detection: NATIVE_PG, user: 'tazaxy', password: 'hunter2', database: 'tazaxy',
  });
  assert.equal(out.state.state, 'NEEDS_CREDENTIALS');
  assert.doesNotMatch(JSON.stringify(out), /hunter2/, 'the password must never appear in a result');
});

test('the real network subnet wins over the pinned default', async () => {
  // An older network still exists with a different subnet: a pg_hba rule for
  // the pinned default would look right and silently not match.
  const { runtime } = dockerRuntime({ subnet: '172.19.0.0/16', gateway: '172.19.0.1', reach: false });
  const out = await createDbConnectivityVerifier({ runtime }).verify({
    detection: NATIVE_PG, user: 'tazaxy', password: 'p', database: 'tazaxy',
  });
  assert.equal(out.route.host, '172.19.0.1');
  assert.match(out.remediation[1], /172\.19\.0\.0\/16/);
});

test('network inspection resolves the current Linux bridge after recreation', async () => {
  const first = dockerRuntime({ networkId: 'e45063ab247e000000000000' });
  const second = dockerRuntime({ networkId: 'ffd9ce2a170c000000000000' });

  assert.equal((await createDbConnectivityVerifier({ runtime: first.runtime }).inspectNetwork('tazaxy-network')).bridge, 'br-e45063ab247e');
  assert.equal((await createDbConnectivityVerifier({ runtime: second.runtime }).inspectNetwork('tazaxy-network')).bridge, 'br-ffd9ce2a170c');
});

test('native PostgreSQL uses the app bridge gateway even when host-gateway alias points elsewhere', () => {
  const route = resolveAppDatabaseHost({
    detectedHost: 'host.docker.internal',
    deployment: 'native-host',
    appInDocker: true,
    gateway: '172.31.5.1',
    hostGatewayAlias: true,
  });
  assert.equal(route.host, '172.31.5.1');
  assert.equal(route.route, 'bridge-gateway');
});

test('missing app network is reported instead of probing a network that is not there', async () => {
  const { runtime } = dockerRuntime({ networkExists: false });
  const out = await createDbConnectivityVerifier({ runtime }).verify({
    detection: NATIVE_PG, user: 'tazaxy', password: 'p', database: 'tazaxy',
  });
  assert.equal(out.networkMissing, true);
  assert.equal(out.probe, null);
});

test('pg_isready failure detail is retained but credentials are scrubbed', async () => {
  const { runtime } = dockerRuntime({ reach: false });
  runtime.run = async (file, args) => {
    if (args[0] === 'network') {
      return {
        ok: true, code: 0, stderr: '',
        stdout: JSON.stringify({ Id: 'ffd9ce2a170c0', Driver: 'bridge', Options: {}, IPAM: { Config: [{ Subnet: DEFAULT_SUBNET, Gateway: DEFAULT_GATEWAY }] } }),
      };
    }
    return { ok: false, code: 2, stdout: '', stderr: 'no response for secret-value' };
  };
  const out = await createDbConnectivityVerifier({ runtime }).verify({
    detection: NATIVE_PG, user: 'tazaxy', password: 'secret-value', database: 'tazaxy',
  });
  assert.match(out.state.detail, /no response for \*\*\*/);
  assert.doesNotMatch(JSON.stringify(out), /secret-value/);
});
