#!/usr/bin/env node
/**
 * register-and-record.js
 *
 * Runs scripts/register-panel.cjs, captures its output and records the
 * registration result into installer-state.json under state.xui.registration.
 *
 * Usage:
 *   node cli/installer/register-and-record.js
 *
 * Behavior:
 *  - Executes node scripts/register-panel.cjs
 *  - Looks for lines starting with PANEL_REGISTERED: or PANEL_ALREADY_REGISTERED:
 *    and parses the trailing JSON.
 *  - Updates installer-state.json:
 *      state.xui.registration = { kind, data, raw, timestamp, registeredBy }
 *      adds 'xui_registered' to state.completedStages if not present
 *  - Prints concise summary to stdout.
 */
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const REGISTER_SCRIPT = path.join('scripts', 'register-panel.cjs');
const STATE_PATH = path.resolve(process.cwd(), 'installer-state.json');

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { installerVersion: '0.0', date: new Date().toISOString() };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function parseRegisterOutput(stdout) {
  // Find PANEL_REGISTERED: or PANEL_ALREADY_REGISTERED: lines and parse JSON after colon
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^(PANEL_REGISTERED|PANEL_ALREADY_REGISTERED):\\s*(\\{.*\\})$/);
    if (m) {
      try {
        return { kind: m[1], data: JSON.parse(m[2]), raw: line };
      } catch (e) {
        return { kind: m[1], data: null, raw: line, parseError: e.message };
      }
    }
  }
  return null;
}

(async () => {
  console.log('Running register script:', REGISTER_SCRIPT);
  exec(`node ${REGISTER_SCRIPT}`, { cwd: process.cwd(), timeout: 0, env: process.env }, (err, stdout, stderr) => {
    const now = new Date().toISOString();
    const out = (stdout || '') + (stderr ? '\\n' + stderr : '');
    const parsed = parseRegisterOutput(stdout || '');

    const state = loadState();
    if (!state.xui) state.xui = {};

    state.xui.registration = {
      timestamp: now,
      rawOutput: out,
      error: err ? (err.message || String(err)) : null,
    };

    if (parsed) {
      state.xui.registration.kind = parsed.kind;
      state.xui.registration.data = parsed.data || null;
      state.xui.registration.rawLine = parsed.raw;
      if (parsed.parseError) state.xui.registration.parseError = parsed.parseError;
    }

    // mark completed stage
    state.completedStages = state.completedStages || [];
    if (!state.completedStages.includes('xui_registered')) {
      state.completedStages.push('xui_registered');
    }

    saveState(state);

    if (parsed && parsed.data) {
      console.log(parsed.kind + ' saved to installer-state.json:', JSON.stringify(parsed.data, null, 2));
      process.exit(0);
    } else {
      console.log('Registration script completed; output recorded to installer-state.json.');
      if (err) {
        console.error('Registration process returned error:', err && err.message ? err.message : err);
        process.exit(err.code || 1);
      } else {
        process.exit(0);
      }
    }
  });
})();