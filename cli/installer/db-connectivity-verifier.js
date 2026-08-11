'use strict';

/**
 * Verifies the database is reachable *from the app's Docker network* before the
 * app is ever started.
 *
 * Probing from the host proves nothing: the host can always reach its own
 * PostgreSQL on loopback. The only probe that matters runs inside a throwaway
 * container attached to the same network the app uses. That is what turns
 * "should work" into "does work" and what stops the restart loop, because the
 * installer refuses to start the app until this passes.
 *
 * All host interaction goes through an injected runtime so the whole thing can
 * be tested without Docker.
 */

const { execFile } = require('child_process');
const {
  classifyDeployment,
  resolveAppDatabaseHost,
  buildHostAuthRule,
  buildListenAddresses,
  routeState,
  DEFAULT_SUBNET,
  DEFAULT_GATEWAY,
} = require('./db-route-resolver');

const PROBE_IMAGE = 'postgres:alpine';
const PROBE_TIMEOUT_MS = 20000;

function defaultRuntime(overrides = {}) {
  const run = (file, args, opts = {}) =>
    new Promise((resolve) => {
      execFile(file, args, { timeout: opts.timeout || PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
          stdout: String(stdout || '').trim(),
          stderr: String(stderr || '').trim(),
        });
      });
    });
  return { run, ...overrides };
}

/**
 * Read the gateway and subnet Docker actually assigned to the app network.
 * Never assume the pinned defaults are in effect — an older network may still
 * exist with a different subnet, and a pg_hba rule for the wrong subnet is
 * worse than none because it looks correct.
 */
async function inspectNetwork(runtime, network) {
  const res = await runtime.run('docker', [
    'network',
    'inspect',
    network,
    '--format',
    '{{json .}}',
  ]);
  if (!res.ok || !res.stdout) {
    return { subnet: null, gateway: null, bridge: null, exists: false };
  }
  let details;
  try {
    details = JSON.parse(res.stdout);
  } catch {
    return { subnet: null, gateway: null, bridge: null, exists: false };
  }
  const ipam = details.IPAM && Array.isArray(details.IPAM.Config) ? details.IPAM.Config[0] || {} : {};
  const explicitBridge = details.Options && details.Options['com.docker.network.bridge.name'];
  const bridge = explicitBridge || (details.Driver === 'bridge' && details.Id ? `br-${String(details.Id).slice(0, 12)}` : null);
  return {
    subnet: ipam.Subnet || null,
    gateway: ipam.Gateway || null,
    bridge,
    exists: true,
  };
}

/**
 * Probe TCP, then authentication, from inside the app network.
 * Two distinct facts: a refused connection is a routing/firewall problem, while
 * a refused login is a credentials problem. Collapsing them sends the operator
 * to the wrong place.
 */
async function probeFromNetwork(runtime, { network, host, port, user, password, database }) {
  const tcp = await runtime.run('docker', [
    'run', '--rm', '--network', network,
    '--entrypoint', 'pg_isready',
    PROBE_IMAGE,
    '-h', host, '-p', String(port), '-t', '5',
  ]);
  if (!tcp.ok) {
    return {
      reachable: false,
      authenticated: false,
      diagnostic: `pg_isready from ${network} could not reach ${host}:${port}`,
      raw: scrubDiagnostic(tcp.stderr || tcp.stdout, password),
    };
  }

  // Password is passed via env, not argv, so it cannot leak through `ps`.
  const auth = await runtime.run('docker', [
    'run', '--rm', '--network', network,
    '--env', `PGPASSWORD=${password || ''}`,
    '--entrypoint', 'psql',
    PROBE_IMAGE,
    '-h', host, '-p', String(port), '-U', user, '-d', database,
    '-tAc', 'select 1',
  ]);

  return {
    reachable: true,
    authenticated: auth.ok && /^1$/m.test(auth.stdout || ''),
    diagnostic: auth.ok ? '' : `authentication against ${database} as ${user} failed`,
    // stderr can echo the connection string; keep the host but never the password.
    raw: auth.ok ? '' : scrubDiagnostic(auth.stderr, password),
  };
}

function scrubDiagnostic(text, secret) {
  let value = String(text || '').replace(/password=\S+/gi, 'password=***');
  if (secret) value = value.split(String(secret)).join('***');
  return value;
}

/**
 * Full resolve-then-verify pass.
 *
 * Returns the state, the DATABASE_URL host the app should use, and — when the
 * route fails — the exact remediation for this host, rather than generic advice.
 */
function createDbConnectivityVerifier({ runtime: overrides } = {}) {
  const runtime = defaultRuntime(overrides);

  async function verify(opts = {}) {
    const {
      detection = {},
      network = 'tazaxy-network',
      appInDocker = true,
      user,
      password,
      database,
      port = 5432,
    } = opts;

    const deployment = classifyDeployment(detection);
    const net = await inspectNetwork(runtime, network);
    if (net.exists && (!net.subnet || !net.gateway || !net.bridge)) {
      throw new Error(`Docker network ${network} has no inspectable IPv4 subnet/gateway/bridge`);
    }
    const subnet = net.subnet || DEFAULT_SUBNET;
    const gateway = net.gateway || DEFAULT_GATEWAY;

    const route = resolveAppDatabaseHost({
      detectedHost: detection.host || '127.0.0.1',
      deployment,
      appInDocker,
      containerName: detection.containerName || null,
      gateway,
    });

    // Nothing containerised to probe from: report the resolution only.
    if (!appInDocker || !net.exists) {
      return {
        deployment,
        route,
        subnet,
        gateway,
        probe: null,
        state: null,
        networkMissing: !net.exists,
      };
    }

    const probe = await probeFromNetwork(runtime, {
      network,
      host: route.host,
      port,
      user,
      password,
      database,
    });

    const state = routeState({ probe, host: route.host, port, route: route.route, component: 'database' });

    // On failure, hand back the two exact edits this host needs.
    const remediation = probe.reachable
      ? []
      : [
          `listen_addresses = '${buildListenAddresses({ gateway })}'`,
          buildHostAuthRule({ database, user, subnet }),
        ];

    return { deployment, route, subnet, gateway, bridge: net.bridge, probe, state, remediation, networkMissing: false };
  }

  return { verify, inspectNetwork: (network) => inspectNetwork(runtime, network) };
}

module.exports = { createDbConnectivityVerifier, PROBE_IMAGE, PROBE_TIMEOUT_MS };
