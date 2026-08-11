'use strict';

/**
 * Regression tests for postgres-provisioner.
 *
 * Every fixture here is taken from the acceptance server (91.107.249.248),
 * where the installer had written the 3X-UI panel's own database into Tazaxy's
 * DATABASE_URL and PostgreSQL was listening on localhost only:
 *
 *   DATABASE_URL=postgres://JkG5bxMe:***@127.0.0.1:5432/xui?sslmode=disable
 *   databases: postgres, xui      (no `tazaxy`)
 *   listen_addresses: (default = localhost)
 *   pg_hba: host xui all 127.0.0.1/32 md5
 *   tazaxy-network: 172.20.0.0/16 gw 172.20.0.1
 *   result: tazaxy-app-1 restarting, 283 restarts, exit 1
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createPostgresProvisioner,
  planHbaContent,
  planConfContent,
  quoteIdent,
  scrub,
} = require('./postgres-provisioner');

/** pg_hba.conf as it exists on the acceptance server. */
const SERVER_HBA = [
  '# TYPE  DATABASE        USER            ADDRESS                 METHOD',
  'local   all             postgres                                peer',
  'host    xui    all    127.0.0.1/32    md5',
  'host    xui    all    ::1/128         md5',
  'host    all             all             127.0.0.1/32            scram-sha-256',
].join('\n');

/** Fake runtime: records commands, returns queued outputs. */
function makeRuntime(responses = {}) {
  const calls = [];
  const writes = [];
  return {
    calls,
    writes,
    async run(cmd, args) {
      const line = [cmd, ...(args || [])].join(' ');
      calls.push(line);
      for (const [pattern, value] of Object.entries(responses)) {
        if (line.includes(pattern)) {
          return { ok: true, stdout: value, stderr: '', ...(value && value.__override) };
        }
      }
      return { ok: true, stdout: '', stderr: '' };
    },
    async writeFile(path, content) {
      writes.push({ path, content });
      return { ok: true };
    },
  };
}

test('creates the tazaxy database when only postgres and xui exist', async () => {
  const runtime = makeRuntime({
    'FROM pg_database': 'postgres\nxui\n',
    'FROM pg_roles': '',
  });
  const p = createPostgresProvisioner({ runtime });
  const res = await p.ensureRoleAndDatabase({
    role: 'tazaxy',
    password: 'pw',
    database: 'tazaxy',
  });

  assert.equal(res.databaseCreated, true, 'the missing tazaxy database must be created');
  assert.equal(res.roleCreated, true);
  assert.ok(
    runtime.calls.some((c) => c.includes('CREATE DATABASE "tazaxy" OWNER "tazaxy"')),
    'must create tazaxy owned by its own role',
  );
});

test('never drops or recreates the panel database, and never reuses it', async () => {
  const runtime = makeRuntime({ 'FROM pg_database': 'postgres\nxui\n' });
  const p = createPostgresProvisioner({ runtime });
  const res = await p.ensureRoleAndDatabase({
    role: 'tazaxy',
    password: 'pw',
    database: 'tazaxy',
  });

  const sqlText = runtime.calls.join('\n');
  assert.ok(!/DROP DATABASE/i.test(sqlText), 'must never issue DROP DATABASE');
  assert.ok(!/CREATE DATABASE "xui"/i.test(sqlText), 'must never touch the panel database');
  assert.ok(res.preserved.includes('xui'), 'the panel database must be reported as preserved');
});

test('an existing tazaxy database is reused, not recreated', async () => {
  const runtime = makeRuntime({
    'FROM pg_database': 'postgres\nxui\ntazaxy\n',
    'FROM pg_roles': '1',
  });
  const p = createPostgresProvisioner({ runtime });
  const res = await p.ensureRoleAndDatabase({ role: 'tazaxy', password: 'pw', database: 'tazaxy' });

  assert.equal(res.databaseCreated, false);
  assert.ok(!runtime.calls.some((c) => /CREATE DATABASE/i.test(c)), 'must not recreate');
  assert.ok(runtime.calls.some((c) => /GRANT ALL PRIVILEGES ON DATABASE "tazaxy"/.test(c)));
});

test('pg_hba gains a scoped rule and keeps every existing panel rule', () => {
  const rule = 'host    tazaxy    tazaxy    172.20.0.0/16    scram-sha-256';
  const plan = planHbaContent(SERVER_HBA, rule);

  assert.equal(plan.changed, true);
  assert.ok(plan.content.includes(rule), 'our rule must be present');
  assert.ok(plan.content.includes('host    xui    all    127.0.0.1/32    md5'), 'panel rule kept');
  assert.ok(plan.content.includes('local   all             postgres'), 'local rules kept');
  assert.ok(!plan.content.includes('0.0.0.0/0'), 'must never open to the world');

  // Our rule must come before the broad `all` rule, or it would be shadowed.
  const ours = plan.content.indexOf('host    tazaxy');
  const broad = plan.content.indexOf('host    all             all');
  assert.ok(ours < broad, 'scoped rule must precede the broad rule');
});

test('applying pg_hba twice is a no-op the second time', () => {
  const rule = 'host    tazaxy    tazaxy    172.20.0.0/16    scram-sha-256';
  const once = planHbaContent(SERVER_HBA, rule);
  const twice = planHbaContent(once.content, rule);
  assert.equal(twice.changed, false, 'idempotent: no duplicate rules on re-run');
});

test('listen_addresses picks up the real gateway and keeps localhost', () => {
  // Server had no explicit setting, so the default localhost applies.
  const plan = planConfContent("#listen_addresses = 'localhost'", 'localhost,172.20.0.1');
  assert.equal(plan.changed, true);
  assert.ok(plan.content.includes("listen_addresses = 'localhost,172.20.0.1'"));
  assert.ok(!plan.content.includes("listen_addresses = '*'"), "must never bind '*'");
});

test('an existing listen_addresses is commented out, not deleted', () => {
  const plan = planConfContent("listen_addresses = 'localhost'\nport = 5432", 'localhost,172.20.0.1');
  assert.ok(plan.content.includes("# listen_addresses = 'localhost'"), 'old value preserved');
  assert.ok(plan.content.includes('port = 5432'), 'unrelated settings untouched');
});

test('config files are backed up before being modified', async () => {
  const runtime = makeRuntime({
    'cat /etc/postgresql/14/main/pg_hba.conf': SERVER_HBA,
    'cat /etc/postgresql/14/main/postgresql.conf': "#listen_addresses = 'localhost'",
  });
  const p = createPostgresProvisioner({ runtime });
  const res = await p.ensureNetworkAccess({
    role: 'tazaxy',
    database: 'tazaxy',
    subnet: '172.20.0.0/16',
    gateway: '172.20.0.1',
    confPath: '/etc/postgresql/14/main/postgresql.conf',
    hbaPath: '/etc/postgresql/14/main/pg_hba.conf',
  });

  assert.equal(res.backups.length, 2, 'both files backed up');
  assert.ok(res.backups.every((b) => b.endsWith('.bak')));
  assert.ok(runtime.calls.some((c) => c.startsWith('cp -a /etc/postgresql/14/main/pg_hba.conf')));
  assert.equal(res.restarted, true, 'listen_addresses changed, so a restart is required');
});

test('refuses a public subnet even if detection somehow yields one', async () => {
  const runtime = makeRuntime();
  const p = createPostgresProvisioner({ runtime });
  await assert.rejects(
    () =>
      p.ensureNetworkAccess({
        role: 'tazaxy',
        database: 'tazaxy',
        subnet: '0.0.0.0/0',
        gateway: '172.20.0.1',
        confPath: '/c',
        hbaPath: '/h',
      }),
    /public access/,
  );
  assert.equal(runtime.writes.length, 0, 'nothing may be written when refusing');
});

test('rejects unsafe SQL identifiers instead of interpolating them', () => {
  assert.throws(() => quoteIdent('tazaxy; DROP DATABASE xui'), /unsafe SQL identifier/);
  assert.throws(() => quoteIdent('"'), /unsafe SQL identifier/);
  assert.equal(quoteIdent('tazaxy'), '"tazaxy"');
});

test('passwords never survive into error text', () => {
  assert.equal(scrub('failed for s3cret', 's3cret'), 'failed for ***');
});

test('stale bridge with the same route does not count as valid without proven ownership', async () => {
  const runtime = makeRuntime({
    'ufw status numbered': 'Status: active\n[ 1] 172.31.0.1 5432/tcp on br-old ALLOW IN 172.31.0.0/16\n',
  });
  const result = await createPostgresProvisioner({ runtime }).ensureScopedFirewallRule({
    subnet: '172.31.0.0/16', gateway: '172.31.0.1', bridge: 'br-current', port: 5432,
  });

  assert.equal(result.changed, true);
  assert.equal(runtime.calls.some((call) => call.includes('delete 1')), false, 'unmarked stale rule must be preserved');
  assert.ok(runtime.calls.includes('ufw allow in on br-current from 172.31.0.0/16 to 172.31.0.1 port 5432 proto tcp comment tazaxy-postgres'));
});

test('recreated Docker network removes an owned old-bridge rule and adds the new bridge', async () => {
  const runtime = makeRuntime({
    'ufw status numbered': 'Status: active\n[ 3] 172.31.0.1 5432/tcp on br-old ALLOW IN 172.31.0.0/16 # tazaxy-postgres\n',
  });
  const result = await createPostgresProvisioner({ runtime }).ensureScopedFirewallRule({
    subnet: '172.31.0.0/16', gateway: '172.31.0.1', bridge: 'br-new', port: 5432,
  });

  assert.equal(result.removed, 1);
  assert.ok(runtime.calls.includes('ufw --force delete 3'));
  assert.ok(runtime.calls.some((call) => call.startsWith('ufw allow in on br-new ')));
});

test('exact current interface rule is idempotent', async () => {
  const runtime = makeRuntime({
    'ufw status numbered': 'Status: active\n[ 1] 172.31.0.1 5432/tcp on br-current ALLOW IN 172.31.0.0/16 # tazaxy-postgres\n',
  });
  const result = await createPostgresProvisioner({ runtime }).ensureScopedFirewallRule({
    subnet: '172.31.0.0/16', gateway: '172.31.0.1', bridge: 'br-current', port: 5432,
  });

  assert.equal(result.changed, false);
  assert.equal(runtime.calls.length, 1);
});

test('legacy TAZAXY firewall comment is migrated to the canonical owned rule', async () => {
  const runtime = makeRuntime({
    'ufw status numbered': 'Status: active\n[ 7] 172.31.0.1 5432/tcp on br-current ALLOW IN 172.31.0.0/16 # tazaxy app -> postgres\n',
  });
  const result = await createPostgresProvisioner({ runtime }).ensureScopedFirewallRule({
    subnet: '172.31.0.0/16', gateway: '172.31.0.1', bridge: 'br-current', port: 5432,
  });

  assert.equal(result.removed, 1);
  assert.ok(runtime.calls.includes('ufw --force delete 7'));
  assert.ok(runtime.calls.includes('ufw allow in on br-current from 172.31.0.0/16 to 172.31.0.1 port 5432 proto tcp comment tazaxy-postgres'));
});

test('unrelated UFW rules remain untouched', async () => {
  const runtime = makeRuntime({
    'ufw status numbered': [
      'Status: active',
      '[ 1] 22/tcp ALLOW IN Anywhere # ssh',
      '[ 2] 10.0.0.1 5432/tcp on br-customer ALLOW IN 10.0.0.0/24 # customer-db',
    ].join('\n'),
  });
  await createPostgresProvisioner({ runtime }).ensureScopedFirewallRule({
    subnet: '172.31.0.0/16', gateway: '172.31.0.1', bridge: 'br-current', port: 5432,
  });

  assert.equal(runtime.calls.some((call) => call.includes('delete')), false);
  assert.equal(runtime.calls.filter((call) => call.startsWith('ufw allow')).length, 1);
});
