'use strict';

/**
 * Proves the Telegram transport regression tests are non-vacuous.
 *
 * Loads telegram-detector.js with the two new guards (transport failure and
 * Telegram 5xx) stripped out, i.e. the code as it behaved before the fix, and
 * asserts it produces the wrong state. If this script ever stops reporting
 * NEEDS_CREDENTIALS, the guards are no longer what makes the tests pass.
 *
 * Usage: node scripts/acceptance/prefix-check.cjs
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');

const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmno';
const source = path.join(__dirname, '..', '..', 'cli', 'installer', 'telegram-detector.js');

/**
 * Removes the guard that starts at `marker` up to and including its closing
 * brace, working line by line so CRLF and LF files behave the same.
 */
function removeGuard(lines, marker) {
  const start = lines.findIndex((line) => line.includes(marker));
  if (start === -1) return null;
  const open = lines.findIndex((line, index) => index >= start && /^\s*if \(/.test(line));
  if (open === -1) return null;
  const indent = lines[open].match(/^\s*/)[0];
  const end = lines.findIndex((line, index) => index > open && line === `${indent}}`);
  if (end === -1) return null;
  return [...lines.slice(0, start), ...lines.slice(end + 1)];
}

const original = fs.readFileSync(source, 'utf8');
const eol = original.includes('\r\n') ? '\r\n' : '\n';
let lines = original.split(/\r?\n/);
for (const marker of ['// A transport failure', '// 5xx is Telegram']) {
  const next = removeGuard(lines, marker);
  if (!next) {
    console.error(`FAIL: could not strip the guard at "${marker}"; the code moved.`);
    process.exit(1);
  }
  lines = next;
}
const stripped = lines.join(eol);


// Compile the stripped source in place so its relative requires still resolve.
const scratch = new Module(source, null);
scratch.filename = source;
scratch.paths = Module._nodeModulePaths(path.dirname(source));
scratch._compile(stripped, source);
const { createTelegramDetector } = scratch.exports;

const detector = (response) => createTelegramDetector({ runtime: { request: async () => response } });

(async () => {
  const unreachable = await detector({ statusCode: 0, headers: {}, body: '', error: 'connect ECONNREFUSED' }).validateToken(TOKEN);
  const serverError = await detector({ statusCode: 502, headers: {}, body: '<html>bad gateway</html>' }).validateToken(TOKEN);

  console.log(`pre-fix unreachable -> ${unreachable.state}`);
  console.log(`pre-fix HTTP 502    -> ${serverError.state}`);

  const wrong = unreachable.state === 'NEEDS_CREDENTIALS' && serverError.state === 'NEEDS_CREDENTIALS';
  console.log(wrong ? 'OK: without the guards both are misreported, so the tests are non-vacuous.' : 'FAIL: the guards are not what the tests depend on.');
  process.exit(wrong ? 0 : 1);
})();
