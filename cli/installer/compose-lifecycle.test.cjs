'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createComposeLifecycle, composeCommand, isTazaxyOwned } = require('./compose-lifecycle');

const composeFile = '/opt/tazaxy/docker-compose.yml';
const envFile = '/opt/tazaxy/.env';

function container(id, name, labels = {}, mounts = []) {
  return { Id: id, Name: `/${name}`, Config: { Labels: labels }, Mounts: mounts };
}

function labels(project, service, config = composeFile) {
  return {
    'com.docker.compose.project': project,
    'com.docker.compose.service': service,
    'com.docker.compose.project.config_files': config,
  };
}

function runtimeFor(containers, current = []) {
  const calls = [];
  return {
    calls,
    async run(file, args) {
      calls.push([file, ...args]);
      if (args[0] === 'ps') return { ok: true, stdout: containers.map((item) => item.Id).join('\n'), stderr: '' };
      if (args[0] === 'compose') return { ok: true, stdout: current.join('\n'), stderr: '' };
      if (args[0] === 'inspect') return { ok: true, stdout: JSON.stringify(containers), stderr: '' };
      if (args[0] === 'rm') return { ok: true, stdout: args.slice(2).join('\n'), stderr: '' };
      throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
    },
  };
}

test('partial install rerun removes stale owned app, Redis and MinIO containers only', async () => {
  const owned = [
    container('app-old', 'tazaxy-app-1', labels('vpn-saas', 'app')),
    container('redis-old', 'tazaxy-redis-1', labels('vpn-saas', 'redis'), [{ Type: 'volume', Name: 'tazaxy-redis-data' }]),
    container('minio-old', 'tazaxy-minio-1', labels('vpn-saas', 'minio'), [{ Type: 'volume', Name: 'tazaxy-minio-data' }]),
  ];
  const unrelated = container('customer', 'tazaxy-minio-backup', labels('customer-stack', 'minio', '/srv/customer/compose.yml'));
  const runtime = runtimeFor([...owned, unrelated]);

  const result = await createComposeLifecycle({ runtime }).reconcileStaleContainers({ composeFile, envFile });

  assert.deepEqual(result.removed.sort(), ['tazaxy-app-1', 'tazaxy-minio-1', 'tazaxy-redis-1']);
  assert.deepEqual(result.preserved, ['tazaxy-minio-backup']);
  const removal = runtime.calls.find((call) => call[1] === 'rm');
  assert.deepEqual(removal, ['docker', 'rm', '-f', 'app-old', 'redis-old', 'minio-old']);
  assert.ok(!runtime.calls.some((call) => call.includes('-v')), 'named volumes/data must survive container recreation');
  assert.ok(!runtime.calls.some((call) => call[1] === 'network'), 'the installer-owned external network must not be changed');
});

test('current project containers are kept while stale same-project ownership is self-healed', async () => {
  const active = container('active-redis', 'tazaxy-redis-1', labels('tazaxy', 'redis'));
  const stale = container('stale-minio', 'tazaxy-minio-1', labels('tazaxy', 'minio'));
  const runtime = runtimeFor([active, stale], ['active-redis']);
  const result = await createComposeLifecycle({ runtime }).reconcileStaleContainers({ composeFile, envFile });
  assert.deepEqual(result.removed, ['tazaxy-minio-1']);
  assert.deepEqual(result.preserved, ['tazaxy-redis-1']);
});

test('a similar container name without TAZAXY Compose ownership is never trusted or removed', () => {
  assert.equal(isTazaxyOwned(container('fake', 'tazaxy-minio-1', {}), composeFile), false);
  assert.equal(isTazaxyOwned(container('foreign', 'tazaxy-app-1', labels('other', 'app', '/srv/other.yml')), composeFile), false);
});

test('every lifecycle command pins the same deterministic Compose project', () => {
  const command = composeCommand({ composeFile, envFile }, 'ps');
  assert.match(command, /"compose" "-p" "tazaxy"/);
  assert.match(command, /"-f" "\/opt\/tazaxy\/docker-compose\.yml"/);
});
