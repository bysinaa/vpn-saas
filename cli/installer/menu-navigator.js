'use strict';

/**
 * Menu navigation for the installer CLI.
 *
 * Guarantees enforced here, because they were the source of the reported bugs:
 *  - every submenu offers Back, Retry and Refresh;
 *  - Back pops one level and returns to the parent menu, it never exits;
 *  - only the root menu can exit, and only via its explicit Exit entry;
 *  - the status header is re-derived from live detection after every action, so
 *    a change made in a submenu is visible immediately;
 *  - an action that throws is reported with its step and recovery action and
 *    leaves the user in the same menu rather than unwinding the installer.
 */

const { format } = require('./detection-states');

const BACK = '__back__';
const RETRY = '__retry__';
const REFRESH = '__refresh__';
const EXIT = '__exit__';

/** Appends the navigation entries that every submenu must have. */
function withNavigation(items, { root = false } = {}) {
  const navigation = [
    { value: REFRESH, label: 'Refresh status' },
    { value: RETRY, label: 'Retry last action' },
  ];
  return root
    ? [...items, ...navigation, { value: EXIT, label: 'Exit installer' }]
    : [...items, ...navigation, { value: BACK, label: 'Back' }];
}

function createMenuNavigator({ orchestrator, prompt, logger, refresh } = {}) {
  const log = logger || ((message) => console.log(message));
  const stack = [];
  let snapshot = null;
  let lastAction = null;

  async function refreshStatus() {
    snapshot = refresh ? await refresh() : await orchestrator.detectAll();
    return snapshot;
  }

  /** The live status header; always rendered from a freshly taken snapshot. */
  function renderHeader() {
    if (!snapshot) return '';
    const summary = snapshot.components
      .map((component) => `${component.label}: ${format(component.state)}`)
      .join('\n  ');
    return `\n  ${summary}\n`;
  }

  /**
   * Runs one menu level. `handler(value, context)` performs the chosen action;
   * returning the BACK sentinel from a handler also pops the level.
   */
  async function open(menu) {
    stack.push(menu.key || menu.title);
    if (!snapshot) await refreshStatus();

    try {
      for (;;) {
        log(`\n=== ${menu.title} ===`);
        log(renderHeader());

        const choice = await prompt(menu.title, withNavigation(menu.items, { root: Boolean(menu.root) }));

        if (choice === EXIT && menu.root) return EXIT;
        if (choice === BACK) return BACK;

        if (choice === REFRESH) {
          await refreshStatus();
          log('Status refreshed.');
          continue;
        }

        const action = choice === RETRY ? lastAction : choice;
        if (choice === RETRY && !action) {
          log('There is no previous action to retry.');
          continue;
        }
        if (choice !== RETRY) lastAction = choice;

        try {
          const outcome = await menu.handler(action, { snapshot, refreshStatus, open });
          // A submenu that returns BACK has already unwound one level; staying
          // in this loop is what keeps the installer alive.
          if (outcome === EXIT && menu.root) return EXIT;
        } catch (error) {
          log(`\n  ! Step "${action}" failed: ${String(error?.message || error).slice(0, 200)}`);
          log('  ! Recovery: choose "Retry last action", or "Back" to pick a different step.');
        }

        // Any action may have changed the system, so the header must be re-derived.
        await refreshStatus();
      }
    } finally {
      stack.pop();
    }
  }

  return { open, refreshStatus, renderHeader, get snapshot() { return snapshot; }, get depth() { return stack.length; } };
}

module.exports = { createMenuNavigator, withNavigation, BACK, RETRY, REFRESH, EXIT };
