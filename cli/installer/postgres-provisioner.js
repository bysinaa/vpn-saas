'use strict';

/**
 * postgres-provisioner.js
 *
 * Makes a native-host PostgreSQL reachable by the Tazaxy app container, and
 * ensures Tazaxy owns its *own* role and database.
 *
 * Why this exists: detection told us where PostgreSQL is, and db-route-resolver
 * told us which address the container should dial, but on a fresh box nothing is
 * listening on that address and the Tazaxy database may not exist at all. The
 * installer previously papered over this by writing whatever DSN it could find
 * — on the acceptance server that was the 3X-UI panel's own `xui` database.
 *
 * Rules this module enforces:
 *  - Tazaxy gets its own role and database. It never reuses another product's.
 *  - An existing database is never dropped or re-created.
 *  - Config files are backed up before modification and edited surgically:
 *    unrelated pg_hba rules (notably the panel's `xui` lines) are preserved.
 *  - Authorisation is scoped to <db>/<role>/<docker subnet>. Never 0.0.0.0/0.
 *  - listen_addresses gains the gateway and keeps localhost. Never '*'.
 *  - Every step is idempotent, so a re-run after a partial failure is safe.
 *
 * All shell access goes through an injected runtime, so the decision logic is
 * unit-testable without a database.
 */

const { buildHostAuthRule, buildListenAddresses, assertPrivateSubnet } = require('./db-route-resolver');

const UFW_COMMENT = 'tazaxy-postgres';
const LEGACY_UFW_COMMENT = 'tazaxy app -> postgres';

/** Quote an identifier for SQL (role/database names). */
function quoteIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name || ''))) {
    throw new Error(`unsafe SQL identifier: ${name}`);
  }
  return `"${name}"`;
}

/** Quote a literal for SQL (passwords). Single quotes doubled. */
function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Plan the pg_hba.conf content: keep every existing line, add our rule once,
 * and place it before any broad `all`-database rule so it is actually reached.
 */
function planHbaContent(existing, rule) {
  const lines = String(existing || '').split('\n');
  const already = lines.some((l) => l.trim() === rule.trim());
  if (already) return { content: existing, changed: false };

  const marker = '# added by tazaxy installer (scoped to the app network)';
  // Insert before the first non-comment `host`/`local` rule so a pre-existing
  // reject/broad rule cannot shadow ours.
  let idx = lines.findIndex((l) => /^\s*(host|local)\s/.test(l) && !/^\s*#/.test(l));
  if (idx < 0) idx = lines.length;
  const next = lines.slice(0, idx).concat([marker, rule, ''], lines.slice(idx));
  return { content: next.join('\n'), changed: true };
}

/**
 * Plan postgresql.conf content: set listen_addresses to include the gateway,
 * commenting out any previous setting rather than deleting it.
 */
function planConfContent(existing, value) {
  const lines = String(existing || '').split('\n');
  const desired = `listen_addresses = '${value}'`;
  if (lines.some((l) => l.trim() === desired)) return { content: existing, changed: false };

  const out = [];
  let replaced = false;
  for (const line of lines) {
    if (/^\s*listen_addresses\s*=/.test(line) && !/^\s*#/.test(line)) {
      out.push(`# ${line.trim()}   # superseded by tazaxy installer`);
      if (!replaced) {
        out.push(desired);
        replaced = true;
      }
      continue;
    }
    out.push(line);
  }
  if (!replaced) out.push(`${desired}   # added by tazaxy installer`);
  return { content: out.join('\n'), changed: true };
}

function createPostgresProvisioner({ runtime }) {
  if (!runtime || typeof runtime.run !== 'function') {
    throw new Error('postgres-provisioner requires a runtime with run()');
  }

  /** Run SQL as the postgres superuser via the local socket. */
  async function sql(statement, { database = 'postgres' } = {}) {
    return runtime.run('sudo', ['-u', 'postgres', 'psql', '-d', database, '-tAc', statement]);
  }

  /**
   * Ensure the Tazaxy role and database exist. Never touches other databases.
   * @returns {{roleCreated:boolean, databaseCreated:boolean, preserved:string[]}}
   */
  async function ensureRoleAndDatabase({ role, password, database }) {
    const ident = quoteIdent(role);
    const dbIdent = quoteIdent(database);

    const before = await sql("SELECT datname FROM pg_database WHERE datistemplate=false;");
    const existingDbs = (before.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);

    if (existingDbs.includes(database)) {
      // Do not re-create, do not drop. Just make sure the role can use it.
      const roleRes = await sql(`SELECT 1 FROM pg_roles WHERE rolname=${quoteLiteral(role)};`);
      const roleExists = (roleRes.stdout || '').trim() === '1';
      if (!roleExists) {
        await sql(`CREATE ROLE ${ident} LOGIN PASSWORD ${quoteLiteral(password)};`);
      } else {
        await sql(`ALTER ROLE ${ident} LOGIN PASSWORD ${quoteLiteral(password)};`);
      }
      await sql(`GRANT ALL PRIVILEGES ON DATABASE ${dbIdent} TO ${ident};`);
      await sql(`GRANT ALL ON SCHEMA public TO ${ident};`, { database });
      return {
        roleCreated: !roleExists,
        databaseCreated: false,
        preserved: existingDbs.filter((d) => d !== database),
      };
    }

    const roleRes = await sql(`SELECT 1 FROM pg_roles WHERE rolname=${quoteLiteral(role)};`);
    const roleExists = (roleRes.stdout || '').trim() === '1';
    if (roleExists) {
      await sql(`ALTER ROLE ${ident} LOGIN PASSWORD ${quoteLiteral(password)};`);
    } else {
      await sql(`CREATE ROLE ${ident} LOGIN PASSWORD ${quoteLiteral(password)};`);
    }
    const created = await sql(`CREATE DATABASE ${dbIdent} OWNER ${ident};`);
    if (!created.ok) {
      throw new Error(`could not create database ${database}: ${scrub(created.stderr, password)}`);
    }
    await sql(`GRANT ALL ON SCHEMA public TO ${ident};`, { database });

    return {
      roleCreated: !roleExists,
      databaseCreated: true,
      preserved: existingDbs.filter((d) => d !== database),
    };
  }

  /**
   * Make PostgreSQL accept connections from the app network.
   * pg_hba alone needs a reload; listen_addresses needs a restart, so we only
   * restart when the address actually changed.
   */
  async function ensureNetworkAccess({ role, database, subnet, gateway, confPath, hbaPath }) {
    assertPrivateSubnet(subnet);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const results = { restarted: false, reloaded: false, backups: [], changed: [] };

    // ── pg_hba.conf ──
    const hbaRead = await runtime.run('cat', [hbaPath]);
    if (!hbaRead.ok) throw new Error(`cannot read ${hbaPath}`);
    const rule = buildHostAuthRule({ database, user: role, subnet });
    const hbaPlan = planHbaContent(hbaRead.stdout, rule);
    if (hbaPlan.changed) {
      const backup = `${hbaPath}.tazaxy-${stamp}.bak`;
      await runtime.run('cp', ['-a', hbaPath, backup]);
      await runtime.writeFile(hbaPath, hbaPlan.content);
      results.backups.push(backup);
      results.changed.push('pg_hba.conf');
    }

    // ── postgresql.conf ──
    const confRead = await runtime.run('cat', [confPath]);
    if (!confRead.ok) throw new Error(`cannot read ${confPath}`);
    const currentMatch = /^\s*listen_addresses\s*=\s*'([^']*)'/m.exec(confRead.stdout || '');
    const listenValue = buildListenAddresses({
      gateway,
      existing: currentMatch ? currentMatch[1] : 'localhost',
    });
    const confPlan = planConfContent(confRead.stdout, listenValue);
    if (confPlan.changed) {
      const backup = `${confPath}.tazaxy-${stamp}.bak`;
      await runtime.run('cp', ['-a', confPath, backup]);
      await runtime.writeFile(confPath, confPlan.content);
      results.backups.push(backup);
      results.changed.push('postgresql.conf');
    }

    // Apply: restart only if the listening address changed.
    if (results.changed.includes('postgresql.conf')) {
      const r = await runtime.run('systemctl', ['restart', 'postgresql']);
      if (!r.ok) throw new Error(`postgresql restart failed: ${r.stderr}`);
      results.restarted = true;
    } else if (results.changed.includes('pg_hba.conf')) {
      await sql('SELECT pg_reload_conf();');
      results.reloaded = true;
    }

    results.listenAddresses = listenValue;
    results.rule = rule;
    return results;
  }

  /** Keep native PostgreSQL private while allowing only the app bridge. */
  async function ensureScopedFirewallRule({ subnet, gateway, bridge, port = 5432 }) {
    assertPrivateSubnet(subnet);
    if (!gateway || !/^[A-Za-z0-9_.:-]+$/.test(String(bridge || '')) ||
        !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) {
      throw new Error('a gateway, safe bridge name, and valid PostgreSQL port are required');
    }

    const status = await runtime.run('ufw', ['status', 'numbered']);
    if (!status.ok || !/^Status:\s+active/im.test(status.stdout || '')) {
      return { active: false, changed: false };
    }
    const lines = String(status.stdout).split(/\r?\n/);
    const matchesRoute = (line) =>
      line.includes(subnet) && line.includes(gateway) && line.includes(`${port}/tcp`);
    const isCurrent = (line) =>
      matchesRoute(line) && line.includes(` on ${bridge} `) && line.includes(`# ${UFW_COMMENT}`);
    const already = lines.some(isCurrent);

    const staleOwnedRules = lines
      .filter((line) =>
        (line.includes(`# ${UFW_COMMENT}`) || line.includes(`# ${LEGACY_UFW_COMMENT}`)) && !isCurrent(line),
      )
      .map((line) => /^\s*\[\s*(\d+)\]/.exec(line)?.[1])
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => b - a);
    for (const number of staleOwnedRules) {
      const removed = await runtime.run('ufw', ['--force', 'delete', String(number)]);
      if (!removed.ok) throw new Error(`could not remove stale TAZAXY PostgreSQL firewall rule: ${removed.stderr}`);
    }

    if (already) return { active: true, changed: staleOwnedRules.length > 0, removed: staleOwnedRules.length };

    const added = await runtime.run('ufw', [
      'allow', 'in', 'on', bridge, 'from', subnet, 'to', gateway,
      'port', String(port), 'proto', 'tcp', 'comment', UFW_COMMENT,
    ]);
    if (!added.ok) throw new Error(`could not add scoped PostgreSQL firewall rule: ${added.stderr}`);
    return { active: true, changed: true, removed: staleOwnedRules.length };
  }

  return { ensureRoleAndDatabase, ensureNetworkAccess, ensureScopedFirewallRule };
}

/** Remove a secret from text so it cannot reach logs. */
function scrub(text, secret) {
  if (!text) return '';
  if (!secret) return String(text);
  return String(text).split(secret).join('***');
}

module.exports = {
  createPostgresProvisioner,
  planHbaContent,
  planConfContent,
  quoteIdent,
  quoteLiteral,
  scrub,
};
