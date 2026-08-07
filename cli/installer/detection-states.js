'use strict';

/**
 * Explicit installation states shared by every detector and by the CLI menu.
 *
 * The whole point of this module is that a component's status is *derived*,
 * never remembered. `CONFIGURED` may only be produced by a component that
 * owns local configuration (an .env key, a written file); `CONNECTED` may only
 * be produced by code that actually authenticated and made an authorized call.
 * Nothing may promote a component to `CONNECTED` from cached state.
 */
const STATES = Object.freeze({
  NOT_FOUND: 'NOT_FOUND',
  DETECTED: 'DETECTED',
  NEEDS_CREDENTIALS: 'NEEDS_CREDENTIALS',
  CONFIGURED: 'CONFIGURED',
  CONNECTED: 'CONNECTED',
  FAILED: 'FAILED',
});

const ORDER = Object.freeze([
  STATES.NOT_FOUND,
  STATES.FAILED,
  STATES.NEEDS_CREDENTIALS,
  STATES.DETECTED,
  STATES.CONFIGURED,
  STATES.CONNECTED,
]);

const ICONS = Object.freeze({
  [STATES.NOT_FOUND]: '\u25cb',        // ○
  [STATES.DETECTED]: '\u25d0',         // ◐
  [STATES.NEEDS_CREDENTIALS]: '\u26a0', // ⚠
  [STATES.CONFIGURED]: '\u25cf',       // ●
  [STATES.CONNECTED]: '\u2714',        // ✔
  [STATES.FAILED]: '\u2716',           // ✖
});

const COLORS = Object.freeze({
  [STATES.NOT_FOUND]: '\x1b[90m',
  [STATES.DETECTED]: '\x1b[36m',
  [STATES.NEEDS_CREDENTIALS]: '\x1b[33m',
  [STATES.CONFIGURED]: '\x1b[34m',
  [STATES.CONNECTED]: '\x1b[32m',
  [STATES.FAILED]: '\x1b[31m',
});

function isState(value) {
  return Object.prototype.hasOwnProperty.call(STATES, String(value));
}

/** Highest-ranked state wins when several signals describe one component. */
function mergeStates(...states) {
  const known = states.filter(isState);
  if (known.length === 0) return STATES.NOT_FOUND;
  return known.reduce((best, current) => (ORDER.indexOf(current) > ORDER.indexOf(best) ? current : best), STATES.NOT_FOUND);
}

function rank(state) {
  return ORDER.indexOf(isState(state) ? state : STATES.NOT_FOUND);
}

/** Blocking means the installer cannot deliver a working platform in this state. */
function isBlocking(state) {
  return state === STATES.NOT_FOUND || state === STATES.FAILED || state === STATES.NEEDS_CREDENTIALS;
}

function isSatisfied(state) {
  return state === STATES.CONNECTED || state === STATES.CONFIGURED;
}

function format(state, { color = true } = {}) {
  const normalized = isState(state) ? state : STATES.NOT_FOUND;
  const label = `${ICONS[normalized]} ${normalized}`;
  return color ? `${COLORS[normalized]}${label}\x1b[0m` : label;
}

/**
 * A uniform detector result. Detectors never throw at the caller: a thrown
 * error becomes `FAILED` with a recovery action so optional detection can
 * never terminate the installation.
 */
function result(component, state, extra = {}) {
  return {
    component,
    state: isState(state) ? state : STATES.NOT_FOUND,
    detail: extra.detail || '',
    data: extra.data || {},
    diagnostics: extra.diagnostics || [],
    recovery: extra.recovery || '',
    optional: extra.optional === true,
    observedAt: (extra.now ? extra.now() : new Date()).toISOString(),
  };
}

module.exports = { STATES, ORDER, ICONS, COLORS, isState, mergeStates, rank, isBlocking, isSatisfied, format, result };
