'use strict';

/**
 * `tazaxy --version` must print exactly one line — the CLI version — and exit 0.
 *
 * Previously `--version` fell through to the unknown-command branch, which
 * printed the banner, then the full help text, and exited 1. Scripts that probe
 * the installed version therefore saw a failure. This module is the single
 * source of truth and is unit tested.
 */

const fs = require('fs');
const path = require('path');

const VERSION_FLAGS = new Set(['--version', '-v', 'version']);

function isVersionRequest(argv = []) {
  // Only the first argument counts: `tazaxy panel --version` is a panel option.
  return VERSION_FLAGS.has(String(argv[0] || ''));
}

/** Reads the version from package.json, falling back to a stable default. */
function readVersion({ readFileSync = fs.readFileSync, root = path.resolve(__dirname, '..', '..') } = {}) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const version = String(parsed.version || '').trim();
    if (version) return version;
  } catch {
    /* fall through to the default below */
  }
  return '0.0.0';
}

/**
 * Prints the bare version and reports the exit code. Nothing else — no banner,
 * no help, no trailing diagnostics — is written.
 */
function printVersion({ argv = process.argv.slice(2), write = (line) => process.stdout.write(line), ...options } = {}) {
  if (!isVersionRequest(argv)) return null;
  write(`${readVersion(options)}\n`);
  return 0;
}

module.exports = { isVersionRequest, readVersion, printVersion, VERSION_FLAGS };
