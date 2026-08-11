'use strict';

/**
 * Guards the shipped CLI bundle.
 *
 * The installer's runtime modules under cli/installer/ are plain CommonJS, so
 * `tsc` never emitted them into cli/dist-cli/. The compiled index.js still
 * required them, and every installed CLI died with
 *   Error: Cannot find module './installer/cli-version'
 * on any invocation, including `tazaxy --version`.
 *
 * Neither `tsc --noEmit` nor `ts-node cli/index.ts` can catch that: the former
 * is satisfied by cli-version.d.ts, and the latter resolves the source .js.
 * Only building and then running the built entry point reproduces it, which is
 * what these tests do.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const CLI_SOURCE = path.join(ROOT, 'cli');
const ENTRY = path.join(ROOT, 'cli', 'dist-cli', 'index.js');
const copier = require(path.join(ROOT, 'scripts', 'copy-cli-assets.cjs'));

/** Every `require('.../installer/x')` specifier used by the CLI's TypeScript. */
function installerRequiresFromTypeScript() {
  const found = new Set();
  const pattern = /require\(['"](?:\.\.?\/)+installer\/([\w.-]+)['"]\)/g;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'dist-cli' && entry.name !== 'node_modules') walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
      const source = fs.readFileSync(full, 'utf8');
      for (const match of source.matchAll(pattern)) found.add(match[1]);
    }
  };

  walk(CLI_SOURCE);
  return [...found].sort();
}

test('every installer module the CLI requires is shipped into the bundle', () => {
  const required = installerRequiresFromTypeScript();
  assert.ok(required.length > 0, 'expected the CLI to require at least one installer module');

  const shipped = new Set(copier.copyRuntimeModules());

  for (const specifier of required) {
    const file = specifier.endsWith('.js') ? specifier : `${specifier}.js`;
    assert.ok(
      shipped.has(file),
      `cli requires installer/${specifier} but the build does not ship ${file}; ` +
        'the installed CLI would fail with "Cannot find module"',
    );
    assert.ok(
      fs.existsSync(path.join(copier.TARGET, file)),
      `${file} is missing from ${copier.TARGET} after the copy step`,
    );
  }
});

test('test fixtures are never shipped into the bundle', () => {
  assert.equal(copier.isTestFile('installer-detectors.test.cjs'), true);
  assert.equal(copier.isRuntimeModule('installer-detectors.test.cjs'), false);
  assert.equal(copier.isRuntimeModule('cli-version.js'), true);

  for (const name of fs.readdirSync(copier.TARGET)) {
    assert.ok(!copier.isTestFile(name), `${name} is a test fixture and must not ship`);
  }
});

test('runtime modules removed from source are removed from the bundle', () => {
  const stale = path.join(copier.TARGET, 'removed-legacy-installer.js');
  fs.mkdirSync(copier.TARGET, { recursive: true });
  fs.writeFileSync(stale, 'throw new Error("stale");\n');

  copier.copyRuntimeModules();

  assert.equal(fs.existsSync(stale), false, 'stale executable module remained in the shipped bundle');
});

test('the built CLI prints only the version and exits 0', () => {
  if (!fs.existsSync(ENTRY)) {
    // Build once so this test reflects a real install rather than skipping.
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'cli:build'], {
      cwd: ROOT,
      stdio: 'ignore',
    });
  } else {
    copier.copyRuntimeModules();
  }

  const result = spawnSync(process.execPath, [ENTRY, '--version'], { cwd: ROOT, encoding: 'utf8' });

  assert.equal(result.status, 0, `--version exited ${result.status}: ${result.stderr}`);
  assert.equal(result.stderr.trim(), '', 'nothing should be written to stderr');

  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, `expected exactly one line, got: ${JSON.stringify(lines)}`);
  assert.doesNotMatch(result.stdout, /Cannot find module/);

  // The real version, not the "0.0.0" fallback: resolving package.json from
  // inside the bundle is a different path than from source.
  const expected = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  assert.equal(lines[0], expected, `built CLI reported "${lines[0]}" but package.json says "${expected}"`);

});

test('a bundle missing its installer modules is detected rather than shipped', () => {
  // Simulate the pre-fix bundle: compiled entry point, no installer directory.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tazaxy-bundle-'));
  try {
    const entry = path.join(scratch, 'index.js');
    fs.writeFileSync(entry, "require('./installer/cli-version');\n");

    const result = spawnSync(process.execPath, [entry], { cwd: scratch, encoding: 'utf8' });

    assert.notEqual(result.status, 0, 'a bundle without installer modules must fail loudly');
    assert.match(result.stderr, /Cannot find module/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
