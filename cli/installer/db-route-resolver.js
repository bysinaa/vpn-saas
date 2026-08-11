'use strict';

/**
 * Resolves how the Tazaxy app should reach PostgreSQL.
 *
 * The bug this exists to prevent: the installer runs on the host, where
 * `127.0.0.1:5432` is a correct address for a native PostgreSQL. The app runs
 * in a container, where `127.0.0.1` is the container itself. Writing the host's
 * own loopback into DATABASE_URL makes the app fail with TCP_FAILURE and, with
 * `restart: unless-stopped`, loop forever.
 *
 * So the address depends on *who is connecting*, not just on where the database
 * is. This module makes that explicit and refuses to emit a loopback address for
 * a containerised consumer.
 *
 * Pure logic only: no I/O, no side effects. The connectivity probe that uses it
 * lives in db-connectivity-verifier.js.
 */

const { STATES, result } = require('./detection-states');

/** Addresses that are meaningless to a container talking to the host. */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0', '']);

/** Default subnet for tazaxy-network. Pinned so pg_hba rules stay valid. */
const DEFAULT_SUBNET = '172.28.0.0/16';
/** First usable address in DEFAULT_SUBNET: the host side of the bridge. */
const DEFAULT_GATEWAY = '172.28.0.1';

/** Docker's portable alias for "the host", paired with extra_hosts host-gateway. */
const HOST_GATEWAY_ALIAS = 'host.docker.internal';

function isLoopback(host) {
  return LOOPBACK.has(String(host || '').trim().toLowerCase());
}

/**
 * Decide whether PostgreSQL is a container or a process on the host.
 *
 * `source` comes from postgres-detector.js and is the strongest signal we have:
 * a docker/compose source means a container, systemd/process/port means native.
 *
 * @param {{source?: string, containerName?: string|null}} detection
 * @returns {'docker'|'native-host'|'unknown'}
 */
function classifyDeployment(detection = {}) {
  const source = String(detection.source || '').toLowerCase();
  if (detection.containerName) return 'docker';
  if (/docker|compose|container/.test(source)) return 'docker';
  if (/systemd|process|port|native|pg_isready|socket|config/.test(source)) return 'native-host';
  return 'unknown';
}

/**
 * Pick the host the *app* should dial.
 *
 * @param {object} opts
 * @param {string} opts.detectedHost   Address that worked from the host.
 * @param {'docker'|'native-host'|'unknown'} opts.deployment
 * @param {boolean} opts.appInDocker   True when the app runs in a container.
 * @param {string|null} [opts.containerName] PostgreSQL container, if any.
 * @param {string|null} [opts.gateway] Bridge gateway IP, if already known.
 * @returns {{host: string, route: string, reason: string}}
 */
function resolveAppDatabaseHost(opts = {}) {
  const { detectedHost, deployment, appInDocker, containerName, gateway } = opts;

  // Everything on the host: loopback is correct and nothing needs rewriting.
  if (!appInDocker) {
    return {
      host: detectedHost || '127.0.0.1',
      route: 'host-local',
      reason: 'app runs on the host, so the detected address is already reachable',
    };
  }

  // Both containerised: talk over the shared Docker network by service name.
  if (deployment === 'docker' && containerName) {
    return {
      host: containerName,
      route: 'docker-network',
      reason: `app and PostgreSQL share a Docker network; using container name "${containerName}"`,
    };
  }

  // Native PostgreSQL must use the gateway of the app's actual bridge. Docker's
  // host-gateway alias can resolve to a different bridge (commonly docker0).
  if (deployment === 'native-host') {
    return {
      host: gateway || DEFAULT_GATEWAY,
      route: 'bridge-gateway',
      reason: 'container reaches native PostgreSQL through the app network gateway',
    };
  }

  // Unknown deployment with an already-routable address: preserve it.
  if (!isLoopback(detectedHost)) {
    // Already a routable address (a LAN IP or hostname): keep it, do not invent one.
    return {
      host: detectedHost,
      route: 'explicit-host',
      reason: 'detected address is already routable from a container',
    };
  }

  return {
    host: gateway || DEFAULT_GATEWAY,
    route: 'bridge-gateway',
    reason: 'container reaches host PostgreSQL through the Docker bridge gateway, not its own loopback',
  };
}

/**
 * Build DATABASE_URL, refusing to emit an address the consumer cannot reach.
 * Failing loudly here is much cheaper than a restart loop the operator has to
 * diagnose from container logs.
 *
 * @throws {Error} when a containerised consumer would get a loopback address.
 */
function buildDatabaseUrl(parts = {}) {
  const { user, password, host, port, database, schema = 'public', appInDocker } = parts;
  if (appInDocker && isLoopback(host)) {
    throw new Error(
      `refusing to write DATABASE_URL host "${host}" for a containerised app: ` +
        'inside the container that address is the container itself, not the host',
    );
  }
  if (!host || !port || !database || !user) {
    throw new Error('buildDatabaseUrl requires user, host, port and database');
  }
  const credentials = `${encodeURIComponent(user)}:${encodeURIComponent(password || '')}`;
  return `postgresql://${credentials}@${host}:${port}/${database}?schema=${schema}`;
}

/**
 * The pg_hba.conf rule that permits exactly the Tazaxy Docker subnet.
 * Deliberately not 0.0.0.0/0: the database must not become publicly reachable
 * as a side effect of making it reachable from one container.
 */
function assertPrivateSubnet(subnet) {
  const value = String(subnet || '').trim();
  if (!value) throw new Error('a subnet is required');
  if (/^0\.0\.0\.0\/0$|^::\/0$/.test(value)) {
    throw new Error(`refusing to authorise PostgreSQL for "${value}": that is public access`);
  }
  return value;
}

function buildHostAuthRule({ database, user, subnet = DEFAULT_SUBNET, method = 'scram-sha-256' }) {
  if (!database || !user) throw new Error('buildHostAuthRule requires database and user');
  assertPrivateSubnet(subnet);
  return `host    ${database}    ${user}    ${subnet}    ${method}`;
}


/**
 * listen_addresses must include the bridge gateway, and must stay off the
 * public interfaces. Returns the value to set, never a bare '*'.
 */
function buildListenAddresses({ gateway = DEFAULT_GATEWAY, existing = 'localhost' } = {}) {
  const current = String(existing || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== '*');
  const wanted = new Set(['localhost', ...current, gateway]);
  return [...wanted].join(',');
}

/**
 * Turn a probe outcome into a state the menu can show.
 *
 * The important case: the database was found but the app cannot reach it. That
 * is `DETECTED` with an unreachable route — not `CONFIGURED`, and not a reason
 * to start the app and let it restart-loop.
 */
function routeState({ probe, host, port, route, component = 'database' }) {
  const where = `${host}:${port}`;
  const diagnostic = [probe && probe.diagnostic, probe && probe.raw].filter(Boolean).join(': ');
  if (probe && probe.authenticated) {
    return result(component, STATES.CONNECTED, {
      detail: `app network reached PostgreSQL at ${where} via ${route} and authenticated`,
      data: { host, port, route, reachable: true, authenticated: true },
    });
  }
  if (probe && probe.reachable) {
    return result(component, STATES.NEEDS_CREDENTIALS, {
      detail: `${where} accepts TCP from the app network but rejected the credentials`,
      recovery: 'Check POSTGRES_USER / POSTGRES_PASSWORD, then retry.',
      data: { host, port, route, reachable: true, authenticated: false },
    });
  }
  return result(component, STATES.DETECTED, {

    detail: `PostgreSQL exists but is UNREACHABLE from the app network at ${where} via ${route}${diagnostic ? ` (${diagnostic})` : ''}`,
    recovery:
      'Add the Tazaxy Docker subnet to pg_hba.conf and include the bridge gateway in ' +
      'listen_addresses, then retry. The app stays stopped until this succeeds.',
    data: { host, port, route, reachable: false, authenticated: false, unreachable: true },
  });
}

module.exports = {
  classifyDeployment,
  resolveAppDatabaseHost,
  buildDatabaseUrl,
  buildHostAuthRule,
  buildListenAddresses,
  assertPrivateSubnet,
  routeState,

  isLoopback,
  DEFAULT_SUBNET,
  DEFAULT_GATEWAY,
  HOST_GATEWAY_ALIAS,
};
