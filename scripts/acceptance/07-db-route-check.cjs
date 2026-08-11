'use strict';
/**
 * Proves the db-route regression tests are not vacuous: reconstruct the exact
 * DATABASE_URL the old auto-config.js:202 produced and confirm the new builder
 * refuses it, while still producing a working URL for the same inputs.
 */
const { buildDatabaseUrl, resolveAppDatabaseHost, DEFAULT_GATEWAY } = require('../../cli/installer/db-route-resolver');

const c = { user: 'tazaxy', password: 'p', host: '127.0.0.1', port: 5432, db: 'tazaxy' };
const old = 'postgresql://' + c.user + ':' + c.password + '@' + c.host + ':' + c.port + '/' + c.db + '?schema=public';
console.log('OLD (shipped, caused TCP_FAILURE restart loop):');
console.log('  ' + old);

let vacuous = false;
try {
  buildDatabaseUrl({ user: c.user, password: c.password, host: c.host, port: c.port, database: c.db, appInDocker: true });
  vacuous = true;
  console.log('NEW: produced the same URL -> GUARD IS VACUOUS');
} catch (e) {
  console.log('NEW: rejected -> ' + e.message);
}

const route = resolveAppDatabaseHost({ detectedHost: c.host, deployment: 'native-host', appInDocker: true, gateway: DEFAULT_GATEWAY });
const fixed = buildDatabaseUrl({ user: c.user, password: c.password, host: route.host, port: c.port, database: c.db, appInDocker: true });
console.log('NEW (what the app receives):');
console.log('  ' + fixed);
console.log('route=' + route.route + '  loopback=' + /127\.0\.0\.1|localhost/.test(fixed));

process.exit(vacuous || /127\.0\.0\.1|localhost/.test(fixed) ? 1 : 0);
