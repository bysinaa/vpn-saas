'use strict';

/**
 * Copies the installer's plain-JavaScript modules into the compiled CLI bundle.
 *
 * `tsc -p cli/tsconfig.json` only emits `cli/**\/*.ts`, so the hand-written
 * CommonJS modules under `cli/installer/` never reached `cli/dist-cli/`. The
 * compiled `index.js` still required them at runtime, so every installed CLI
 * failed with "Cannot find module './installer/cli-version'". Type checking
 * could not catch it: `cli-version.d.ts` satisfies the compiler, and running
 * from source via ts-node resolves the real `.js` file.
 *
 * Test fixtures are deliberately excluded from the shipped bundle.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'cli', 'installer');
const TARGET = path.join(ROOT, 'cli', 'dist-cli', 'installer');

/** Files that exist only for tests and must never ship. */
const isTestFile = (name) => name.endsWith('.test.cjs') || name.endsWith('.test.js');

/** Runtime modules the CLI loads by require() at run time. */
const isRuntimeModule = (name) => name.endsWith('.js') && !isTestFile(name);

function copyRuntimeModules() {
  if (!fs.existsSync(SOURCE)) {
    throw new Error(`installer source directory is missing: ${SOURCE}`);
  }

  fs.mkdirSync(TARGET, { recursive: true });

  const sourceModules = new Set(fs.readdirSync(SOURCE).filter(isRuntimeModule));
  for (const entry of fs.readdirSync(TARGET, { withFileTypes: true })) {
    if (entry.isFile() && isRuntimeModule(entry.name) && !sourceModules.has(entry.name)) {
      fs.unlinkSync(path.join(TARGET, entry.name));
    }
  }

  const copied = [];
  for (const entry of fs.readdirSync(SOURCE, { withFileTypes: true })) {
    if (!entry.isFile() || !isRuntimeModule(entry.name)) continue;
    fs.copyFileSync(path.join(SOURCE, entry.name), path.join(TARGET, entry.name));
    copied.push(entry.name);
  }

  return copied.sort();
}

if (require.main === module) {
  try {
    const copied = copyRuntimeModules();
    console.log(`[cli:build] copied ${copied.length} installer module(s) into cli/dist-cli/installer`);
  } catch (error) {
    console.error(`[cli:build] failed to copy installer modules: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { copyRuntimeModules, isRuntimeModule, isTestFile, SOURCE, TARGET };
