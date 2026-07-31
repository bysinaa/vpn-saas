#!/usr/bin/env node
/**
 * confirm-xui.js
 *
 * Purpose:
 *  - Persist a confirmed 3x-ui base URL into installer-state.json.
 *  - Use: node cli/installer/confirm-xui.js [--base-url=http://host:port]
 *
 * Behavior:
 *  - If --base-url provided, that URL is confirmed.
 *  - Otherwise uses installer-state.json -> xui.selected.url if available.
 *  - Writes state.xui.confirmed = { baseUrl, confirmedBy: 'cli', confirmedAt }
 *  - Prints a concise confirmation summary.
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

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('Failed to read installer-state.json:', e.message);
    process.exit(2);
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write installer-state.json:', e.message);
    process.exit(2);
  }
}

(async function main() {
  const CLI = parseArgs();
  const state = loadState();

  if (!state.xui) state.xui = {};
  const candidate = CLI.baseUrl || (state.xui.selected && state.xui.selected.url) || null;
  if (!candidate) {
    console.error('No base URL available to confirm. Provide --base-url or run detect-xui first.');
    process.exit(3);
  }

  state.xui.confirmed = {
    baseUrl: candidate,
    confirmedBy: 'cli',
    confirmedAt: new Date().toISOString(),
  };

  // Also mark installer progress stage
  state.completedStages = state.completedStages || [];
  if (!state.completedStages.includes('xui_confirmed')) {
    state.completedStages.push('xui_confirmed');
  }

  saveState(state);

  console.log('Confirmed 3x-ui base URL saved to', STATE_PATH);
  console.log('Confirmed base URL:', candidate);
  console.log('Next recommended step: scaffold installer CLI or proceed with panel registration.');
  process.exit(0);
})();