'use strict';

const { execFile } = require('child_process');
const path = require('path');

const COMPOSE_PROJECT_NAME = 'tazaxy';
const TAZAXY_SERVICES = new Set(['app', 'redis', 'minio', 'nginx']);

function composeArgs({ composeFile, envFile }, args = []) {
  return [
    'compose', '-p', COMPOSE_PROJECT_NAME, '-f', composeFile,
    ...(envFile ? ['--env-file', envFile] : []),
    ...args,
  ];
}

function composeCommand({ composeFile, envFile }, subcommand) {
  const prefix = ['docker', ...composeArgs({ composeFile, envFile })]
    .map((value) => `"${String(value).replace(/"/g, '\\"')}"`)
    .join(' ');
  return `${prefix} ${subcommand}`;
}

function samePath(left, right) {
  const normalize = (value) => path.resolve(String(value || '')).replace(/\\/g, '/').toLowerCase();
  return Boolean(left && right) && normalize(left) === normalize(right);
}

function isTazaxyOwned(container, composeFile) {
  const labels = container?.Config?.Labels || {};
  const service = labels['com.docker.compose.service'];
  if (!TAZAXY_SERVICES.has(service)) return false;
  if (labels['com.docker.compose.project'] === COMPOSE_PROJECT_NAME) return true;
  return String(labels['com.docker.compose.project.config_files'] || '')
    .split(',')
    .some((file) => samePath(file.trim(), composeFile));
}

function defaultRuntime() {
  return {
    run(file, args) {
      return new Promise((resolve) => execFile(file, args, { windowsHide: true }, (error, stdout, stderr) => resolve({
        ok: !error,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
      })));
    },
  };
}

function createComposeLifecycle({ runtime = defaultRuntime() } = {}) {
  async function reconcileStaleContainers({ composeFile, envFile }) {
    const all = await runtime.run('docker', ['ps', '-aq', '--filter', 'label=com.docker.compose.service']);
    if (!all.ok) throw new Error(`Unable to inspect Compose containers: ${all.stderr}`);
    const ids = all.stdout.split(/\r?\n/).filter(Boolean);
    if (ids.length === 0) return { removed: [], preserved: [] };

    const current = await runtime.run('docker', composeArgs({ composeFile, envFile }, ['ps', '-aq']));
    if (!current.ok) throw new Error(`Unable to inspect the ${COMPOSE_PROJECT_NAME} Compose project: ${current.stderr}`);
    const currentIds = new Set(current.stdout.split(/\r?\n/).filter(Boolean));
    const inspected = await runtime.run('docker', ['inspect', ...ids]);
    if (!inspected.ok) throw new Error(`Unable to inspect Compose ownership labels: ${inspected.stderr}`);

    let containers;
    try {
      containers = JSON.parse(inspected.stdout || '[]');
    } catch {
      throw new Error('Docker returned invalid container inspection data');
    }

    const stale = containers.filter((container) =>
      !currentIds.has(container.Id) && isTazaxyOwned(container, composeFile),
    );
    if (stale.length > 0) {
      const removed = await runtime.run('docker', ['rm', '-f', ...stale.map((container) => container.Id)]);
      if (!removed.ok) throw new Error(`Unable to remove stale TAZAXY containers: ${removed.stderr}`);
    }

    return {
      removed: stale.map((container) => container.Name.replace(/^\//, '')),
      preserved: containers.filter((container) => !stale.includes(container)).map((container) => container.Name.replace(/^\//, '')),
    };
  }

  return { reconcileStaleContainers };
}

module.exports = {
  COMPOSE_PROJECT_NAME,
  TAZAXY_SERVICES,
  composeArgs,
  composeCommand,
  isTazaxyOwned,
  createComposeLifecycle,
};
