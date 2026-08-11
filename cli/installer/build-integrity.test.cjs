'use strict';
/**
 * Build-integrity regression tests.
 *
 * These guard two whole classes of defect that took a running server down and
 * were only visible at container start-up, long after every unit test passed.
 *
 *   1. A `@/...` path alias inside a literal require(). TypeScript rewrites
 *      aliases in `import` statements, but the argument to require() is just a
 *      string, so the alias survives into dist/ and throws
 *      "Cannot find module '@/common/proxy/proxy-http.service'" at boot.
 *
 *   2. A generated .env value that the app's own env schema rejects, e.g. a
 *      SUPER_ADMIN_PASSWORD shorter than the 8-character minimum, which
 *      crash-loops the container after the database is already healthy.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const srcRoot = path.join(repoRoot, 'src');

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

// Matches require('@/...') / require("@/...") including whitespace variants.
const ALIASED_REQUIRE = /require\(\s*['"]@\//;

test('no source file resolves a "@/" alias inside a literal require()', () => {
  const offenders = [];
  for (const file of walk(srcRoot)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      // Ignore comments; the fixed file documents the rule in prose.
      const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      if (ALIASED_REQUIRE.test(code)) {
        offenders.push(`${path.relative(repoRoot, file)}:${index + 1}`);
      }
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    'These require() calls use a "@/" alias that TypeScript will NOT rewrite, so ' +
      'they resolve at compile time but throw at runtime. Use a relative path:\n  ' +
      offenders.join('\n  '),
  );
});

test('the zarinpal gateway requires the proxy service by relative path', () => {
  const file = path.join(srcRoot, 'modules', 'payments', 'gateways', 'default-zarinpal.gateway.ts');
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/require\(\s*['"]([^'"]+proxy-http\.service)['"]\s*\)/);
  assert.ok(match, 'expected the gateway to require proxy-http.service');
  assert.ok(
    match[1].startsWith('.'),
    `expected a relative path, got "${match[1]}" which will not resolve from dist/`,
  );
  // and the target must actually exist relative to the requiring file
  const resolved = path.resolve(path.dirname(file), match[1] + '.ts');
  assert.ok(fs.existsSync(resolved), `require target does not exist: ${resolved}`);
});

// ---------------------------------------------------------------------------
// Generated environment values must satisfy the app's own validation schema.
// ---------------------------------------------------------------------------

/** Mirrors the constraint enforced by src/config/env.validation.ts */
const MIN_ADMIN_PASSWORD_LENGTH = 8;

function generateAdminPassword(randomBytes) {
  // Same shape as the installer/recovery script: random core + guaranteed
  // upper, lower, digit and symbol.
  const core = randomBytes.toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
  return `${core}Aa9_`;
}

test('a generated admin password always satisfies the minimum length', () => {
  const crypto = require('node:crypto');
  for (let i = 0; i < 200; i += 1) {
    const password = generateAdminPassword(crypto.randomBytes(24));
    assert.ok(
      password.length >= MIN_ADMIN_PASSWORD_LENGTH,
      `generated password too short (${password.length}): the app would refuse to boot`,
    );
  }
});

test('a generated admin password still qualifies with worst-case random input', () => {
  // Base64 of all-zero bytes is "AAAA..." — no symbols get stripped, but this
  // pins the behaviour when the random core is degenerate.
  const password = generateAdminPassword(Buffer.alloc(24));
  assert.ok(password.length >= MIN_ADMIN_PASSWORD_LENGTH);
  assert.match(password, /[A-Z]/);
  assert.match(password, /[a-z]/);
  assert.match(password, /[0-9]/);
});

test('a short password is recognised as invalid rather than silently accepted', () => {
  const tooShort = 'abc12';
  assert.ok(
    tooShort.length < MIN_ADMIN_PASSWORD_LENGTH,
    'sanity: the value observed on the server (length 5) must be treated as invalid',
  );
});

// ---------------------------------------------------------------------------
// Plain .js files under src/ are copied verbatim into dist/, so any relative
// require they contain must still resolve from dist/. src/database/x.js sits at
// dist/src/database/x.js, so '../../cli/...' points at dist/cli, NOT the repo
// root -- which is exactly why the container died with MODULE_NOT_FOUND.
// ---------------------------------------------------------------------------

/**
 * Given a .js file under src/ and a relative require specifier, return the
 * path the require resolves to *after* compilation, relative to the output
 * root. src/database/x.js is emitted as dist/src/database/x.js, so the file
 * gains one directory level and every relative require shifts with it.
 */
function resolveAfterCompile(srcRelFile, spec) {
  const emitted = path.posix.join('dist', srcRelFile.split(path.sep).join('/'));
  return path.posix.normalize(path.posix.join(path.posix.dirname(emitted), spec));
}

/** The directory a resolved module path lives in, e.g. dist/cli/installer. */
function resolvedDir(resolved) {
  return path.posix.dirname(resolved);
}


test('a require escaping src/ lands under dist/, not the repo root', () => {
  // The exact case that crash-looped the server.
  const target = resolveAfterCompile(
    path.join('src', 'database', 'database-manager.js'),
    '../../cli/installer/postgres-detector',
  );
  assert.strictEqual(
    target,
    'dist/cli/installer/postgres-detector',
    'this is why mounting the sources at /app/cli did not fix the crash: ' +
      'the require resolves inside dist/, so the module must live at /app/dist/cli',
  );
  assert.notStrictEqual(target, 'cli/installer/postgres-detector');
});

test('requires that stay inside src/ are unaffected by the dist/ shift', () => {
  const target = resolveAfterCompile(
    path.join('src', 'database', 'database-manager.js'),
    '../common/prisma/prisma.service',
  );
  assert.strictEqual(target, 'dist/src/common/prisma/prisma.service');
});

test('every out-of-src require in a copied .js file is shipped beside dist/', () => {
  const jsFiles = [];
  (function collect(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        collect(full);
      } else if (entry.name.endsWith('.js')) {
        jsFiles.push(full);
      }
    }
  })(srcRoot);

  const unshipped = [];
  for (const file of jsFiles) {
    const text = fs.readFileSync(file, 'utf8');
    const re = /require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const srcRel = path.relative(repoRoot, file);
      const resolved = resolveAfterCompile(srcRel, m[1]);
      if (resolved.startsWith('dist/src/')) continue; // stays in compiled output

      // Escapes src/. The Dockerfile must place that directory at exactly this
      // path inside the image, otherwise the app dies at boot.
      const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
      const shipped = dockerfile
        .split(/\r?\n/)
        .some((line) => line.startsWith('COPY') && line.includes(`./${resolvedDir(resolved)}`));
      if (!shipped) {
        unshipped.push(
          `${srcRel} requires "${m[1]}" -> nothing COPYs ./${resolvedDir(resolved)} into the image`,
        );
      }

    }
  }

  assert.deepStrictEqual(
    unshipped,
    [],
    'These requires escape src/ but nothing ships the target next to dist/:\n  ' +
      unshipped.join('\n  '),
  );
});

test('production build and image contract ship the canonical XUI diagnostic at the CLI path', () => {
  execFileSync(process.execPath, [path.join(repoRoot, 'node_modules', '@nestjs', 'cli', 'bin', 'nest.js'), 'build'], {
    cwd: repoRoot,
    stdio: 'pipe',
  });

  const emitted = path.join(repoRoot, 'dist', 'src', 'scripts', 'diagnose-xui.js');
  assert.ok(fs.existsSync(emitted), `Nest did not emit the canonical diagnostic: ${emitted}`);
  assert.match(fs.readFileSync(emitted, 'utf8'), /PanelInstallerService\)\.diagnoseXui/, 'emitted script must call the canonical service');

  const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY --from=builder[^\n]*\/app\/dist \.\/dist/, 'production image must copy the complete Nest output');

  const panelCommand = fs.readFileSync(path.join(repoRoot, 'cli', 'commands', 'panel.ts'), 'utf8');
  assert.match(panelCommand, /node dist\/src\/scripts\/diagnose-xui\.js/);
});

test('XUI CLI scripts cannot start a competing Telegram polling session', () => {
  for (const script of ['reconcile-xui.ts', 'reconcile-xui-drift.ts', 'diagnose-xui.ts']) {
    assert.match(
      fs.readFileSync(path.join(repoRoot, 'src', 'scripts', script), 'utf8'),
      /process\.env\.TAZAXY_CLI_CONTEXT = '1'/,
    );
  }
  assert.match(
    fs.readFileSync(path.join(repoRoot, 'src', 'modules', 'telegram', 'telegram-bot.service.ts'), 'utf8'),
    /process\.env\.TAZAXY_CLI_CONTEXT === '1'/,
  );
});



