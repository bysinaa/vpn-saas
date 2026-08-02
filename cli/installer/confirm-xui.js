#!/usr/bin/env node
/**
 * confirm-xui.js
 *
 * Purpose:
 *  - Persist a confirmed 3x-ui base URL into installer-state.json.
 *  - If auto-detection found a panel (state.xui.detected === true and state.xui.selected),
 *    auto-confirm the selected URL without requiring manual input.
 *  - If --base-url is provided, that URL takes priority and is confirmed.
 *  - If no URL is available, print a helpful error and exit.
 *
 * Usage:
 *   node cli/installer/confirm-xui.js [--base-url=http://host:port]
 *
 * Behavior:
 *  - Priority: --base-url > state.xui.selected.url > state.xui.confirmed.baseUrl
 *  - Writes state.xui.confirmed = { baseUrl, confirmedBy, confirmedAt, autoConfirmed }
 *  - Marks 'xui_confirmed' in completedStages
 *  - Prints a concise confirmation summary
 */
const fs = require('fs');
const path = require('path');

const STATE_PATH = path.resolve(process.cwd(), 'installer-state.json');

function parseArgs() {
  const out = { baseUrl: null };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--base-url=')) {
      out.baseUrl = a.split('=')[1];
    }
  }
  return out;
}

const _stateManager = require('./state-manager');
const loadState = () => _stateManager.loadState(STATE_PATH);
const saveState = (s) => _stateManager.saveState(STATE_PATH, s);

(async function main() {
  const CLI = parseArgs();
  const state = loadState();

  if (!state.xui) state.xui = {};

  // Priority: CLI --base-url > detected selected URL > existing confirmed URL
  const candidate =
    CLI.baseUrl ||
    (state.xui.selected && state.xui.selected.url) ||
    (state.xui.confirmed && state.xui.confirmed.baseUrl) ||
    null;

  if (!candidate) {
    console.error('No base URL available to confirm.');
    console.error('Options:');
    console.error('  1. Run detect-xui first:  node cli/installer/detect-xui.js');
    console.error('  2. Or provide explicitly:  node cli/installer/confirm-xui.js --base-url=http://host:port');
    process.exit(3);
  }

  const autoConfirmed = !CLI.baseUrl && !!(state.xui.detected && state.xui.selected);

  state.xui.confirmed = {
    baseUrl: candidate,
    confirmedBy: autoConfirmed ? 'auto-detect' : 'cli',
    confirmedAt: new Date().toISOString(),
    autoConfirmed,
  };

  // Also mark installer progress stage
  state.completedStages = state.completedStages || [];
  if (!state.completedStages.includes('xui_confirmed')) {
    state.completedStages.push('xui_confirmed');
  }

  saveState(state);

  console.log('Confirmed 3x-ui base URL saved to', STATE_PATH);
  console.log('Confirmed base URL:', candidate);
  if (autoConfirmed) {
    console.log('(Auto-confirmed from detection results — no manual input needed)');
  }
  console.log('Next step: register the panel with: node cli/installer/installer.js register');
  process.exit(0);
})();