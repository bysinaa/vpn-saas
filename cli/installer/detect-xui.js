#!/usr/bin/env node
'use strict';

/** Compatibility CLI adapter. Discovery itself is read-only and state-free. */
const { createXuiRuntimeDetector } = require('./xui-runtime-detector');
const { createInstallerAdapter } = require('./installer-adapter');

function parseArgs(argv) {
  const options = { insecure: false, json: false, record: false, help: false };
  for (const arg of argv) {
    if (arg.startsWith('--base-url=')) options.baseUrl = arg.slice('--base-url='.length);
    else if (arg === '--insecure') options.insecure = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--record') options.record = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('Usage: detect-xui [--base-url=<url>] [--insecure] [--json] [--record]');
    return null;
  }
  if (options.insecure) console.warn('WARNING: --insecure disables TLS certificate verification for this request only.');
  const result = await (deps.detector || createXuiRuntimeDetector({ runtime: deps.runtime })).discover(options);
  if (options.record || deps.persist === true) await (deps.adapter || createInstallerAdapter(deps)).persistDetection('xui', result);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`${result.state}: ${result.data?.panel?.url || 'no XUI installation detected'}`);
  return result;
}

if (require.main === module) main().catch((error) => { console.error(`detect-xui: ${error.message}`); process.exitCode = 1; });
module.exports = { main, parseArgs, createXuiRuntimeDetector };
