'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.TS_NODE_PROJECT = path.join(__dirname, '..', 'tsconfig.json');
require('ts-node/register/transpile-only');
const { AdminCommand } = require('../commands/admin.ts');

test('admin sync promotes an existing USER through Prisma in the app container', async () => {
  let executed = '';
  class TestCommand extends AdminCommand {
    async loadRuntimeConfig() {
      return { superAdmins: ['123456'], paths: { envFile: '/opt/tazaxy/.env' } };
    }
    async fileExists() { return true; }
    async execCommand(command) {
      executed = command;
      return { ok: true, stdout: '{"promoted":1}', stderr: '', exitCode: 0 };
    }
    log() {}
  }

  await new TestCommand().persistAdminsToDatabase();

  assert.match(executed, /exec -T -e TELEGRAM_ADMIN_IDS=123456 app node -e/);
  assert.match(executed, /user\.updateMany/);
  assert.match(executed, /role:\"USER\"/);
  assert.match(executed, /role:\"SUPER_ADMIN\"/);
});

test('admin sync fails closed when the app container cannot update the role', async () => {
  class TestCommand extends AdminCommand {
    async loadRuntimeConfig() {
      return { superAdmins: ['123456'], paths: { envFile: '/opt/tazaxy/.env' } };
    }
    async fileExists() { return true; }
    async execCommand() {
      return { ok: false, stdout: '', stderr: 'container unavailable', exitCode: 1 };
    }
    log() {}
  }

  await assert.rejects(
    () => new TestCommand().persistAdminsToDatabase(),
    /database synchronization failed: container unavailable/i,
  );
});

test('admin sync rejects a tampered non-numeric configured id before invoking the shell', async () => {
  let executed = false;
  class TestCommand extends AdminCommand {
    async loadRuntimeConfig() {
      return { superAdmins: ['123;bad'], paths: { envFile: '/opt/tazaxy/.env' } };
    }
    async fileExists() { return true; }
    async execCommand() { executed = true; return { ok: true, stdout: '', stderr: '', exitCode: 0 }; }
    log() {}
  }

  await assert.rejects(() => new TestCommand().persistAdminsToDatabase(), /Invalid Telegram ID/);
  assert.equal(executed, false);
});
