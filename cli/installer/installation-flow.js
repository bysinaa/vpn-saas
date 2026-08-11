'use strict';

/**
 * The single automatic installation flow.
 *
 * Order is fixed and enforced by STEPS:
 *   preflight -> detection summary -> optional safe cleanup -> clone/build
 *   launcher -> infrastructure -> 3X-UI discovery/authentication -> Telegram
 *   Bot -> environment generation -> service startup -> final health check
 *
 * Two behaviours are deliberate and load-bearing:
 *  - When a healthy 3X-UI is already detected, the panel step only *discovers*
 *    and authenticates. It never prepares a runtime, never installs a panel and
 *    never touches port 2096 or any other panel port.
 *  - A failed optional step is recorded and skipped; only a failed required
 *    step halts, and it halts with the exact step name and recovery action.
 */

const { createDetectionOrchestrator } = require('./detection-orchestrator');
const { createXuiRuntimeDetector } = require('./xui-runtime-detector');
const { createTelegramDetector } = require('./telegram-detector');
const { createCleanInstaller } = require('./clean-install');
const { STATES, isSatisfied } = require('./detection-states');

const STEPS = Object.freeze([
  { key: 'preflight', label: 'Preflight checks', required: true },
  { key: 'detection', label: 'Detection summary', required: true },
  { key: 'cleanup', label: 'Optional safe cleanup', required: false },
  { key: 'launcher', label: 'Clone / build launcher', required: true },
  { key: 'infrastructure', label: 'Infrastructure (PostgreSQL, Redis, MinIO)', required: true },
  { key: 'panel', label: '3X-UI discovery & authentication', required: true },
  { key: 'telegram', label: 'Telegram Bot configuration', required: true },
  { key: 'environment', label: 'Environment generation', required: true },
  { key: 'services', label: 'Service startup', required: true },
  { key: 'health', label: 'Final health verification', required: true },
]);

function createInstallationFlow({ runtime, detectors, actions = {}, prompts = {}, logger } = {}) {
  const orchestrator = detectors?.orchestrator || createDetectionOrchestrator({ runtime, detectors });
  const xui = detectors?.xui || createXuiRuntimeDetector({ runtime });
  const telegram = detectors?.telegram || createTelegramDetector({ runtime });
  const cleaner = detectors?.cleaner || createCleanInstaller({ runtime });
  const log = logger || (() => {});

  /**
   * 3X-UI: reuse whatever is already installed. Discovery has already read the
   * port, base path and TLS mode, so nothing is asked about them here. Only
   * credentials are ever requested, and only when they cannot be derived.
   */
  async function runPanelStep(context) {
    let detection = context.snapshot.detections.xui;

    if (detection.state === STATES.NOT_FOUND) {
      return { state: STATES.NOT_FOUND, detail: detection.detail, recovery: detection.recovery };
    }

    log(`Reusing the existing 3X-UI installation at ${detection.data.panel?.url} (port ${detection.data.panel?.port} left untouched).`);

    // Try the stored username first; only fall back to prompting on rejection.
    let credentials = context.credentials?.xui || {};
    let authenticated = await xui.authenticate(detection, credentials);

    for (let attempt = 0; attempt < 3 && authenticated.state === STATES.NEEDS_CREDENTIALS; attempt += 1) {
      if (!prompts.panelCredentials) break;
      log(authenticated.detail);
      const supplied = await prompts.panelCredentials({ suggestedUsername: detection.data.authentication?.username, attempt });
      if (!supplied || !supplied.password) break;
      credentials = supplied;
      authenticated = await xui.authenticate(detection, credentials);
    }

    if (authenticated.state === STATES.CONNECTED) {
      context.promoted.xui = authenticated;
      context.credentials.xui = credentials;
      // Refresh the CLI status immediately so the menu reflects the new state.
      await context.refresh();
      return { state: STATES.CONNECTED, detail: authenticated.detail, data: authenticated.data };
    }
    return { state: authenticated.state, detail: authenticated.detail, recovery: authenticated.recovery };
  }

  /** Telegram is mandatory: the flow cannot complete without a validated token. */
  async function runTelegramStep(context) {
    const existing = context.snapshot.detections.telegram;

    // A token already in .env still has to prove itself against getMe.
    if (existing.state === STATES.CONFIGURED && actions.readTelegramToken) {
      const token = await actions.readTelegramToken();
      const validated = await telegram.validateToken(token);
      if (validated.state === STATES.CONNECTED) {
        context.promoted.telegram = validated;
        await context.refresh();
        return { state: STATES.CONNECTED, detail: `Bot @${validated.data.username} is connected`, data: validated.data };
      }
      log('The stored bot token was not accepted by Telegram; a new token is required.');
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!prompts.telegramToken) break;
      const token = await prompts.telegramToken({ attempt });
      if (!token) break;
      const validated = await telegram.validateToken(token);
      if (validated.state !== STATES.CONNECTED) {
        log(`${validated.detail}. ${validated.recovery}`);
        continue;
      }
      // Only a validated token is ever written, and it is written before the
      // configuration reload so the running CLI picks it up at once.
      if (actions.saveTelegramToken) await actions.saveTelegramToken(token);
      if (actions.reloadConfiguration) await actions.reloadConfiguration();
      context.promoted.telegram = validated;
      await context.refresh();
      log(`Telegram bot @${validated.data.username} validated and saved.`);
      return { state: STATES.CONNECTED, detail: `Bot @${validated.data.username} is connected`, data: validated.data };
    }

    return {
      state: STATES.NEEDS_CREDENTIALS,
      detail: 'A valid Telegram bot token was not supplied',
      recovery: 'Create a bot with @BotFather and enter its token; it is required.',
    };
  }

  async function runStep(step, context) {
    switch (step.key) {
      case 'preflight': {
        const system = context.snapshot.detections.system;
        return system.state === STATES.NEEDS_CREDENTIALS
          ? { state: STATES.FAILED, detail: system.detail, recovery: system.recovery }
          : { state: STATES.CONFIGURED, detail: system.detail };
      }
      case 'detection':
        log(orchestrator.render(context.snapshot));
        return { state: STATES.CONFIGURED, detail: `${context.snapshot.satisfied.length} component(s) already satisfied` };
      case 'cleanup': {
        if (!context.options.cleanInstall) return { state: STATES.CONFIGURED, detail: 'Skipped (not requested)' };
        const outcome = await cleaner.execute({ workspace: context.options.workspace, dryRun: context.options.dryRun });
        return {
          state: outcome.ok ? STATES.CONFIGURED : STATES.FAILED,
          detail: `Removed ${outcome.executed.length} Tazaxy resource(s); 3X-UI and unrelated data preserved`,
          data: outcome,
        };
      }
      case 'panel':
        return runPanelStep(context);
      case 'telegram':
        return runTelegramStep(context);
      default: {
        const action = actions[step.key];
        if (!action) return { state: STATES.CONFIGURED, detail: 'No action registered; nothing to do' };
        const outcome = await action(context);
        return outcome && outcome.state ? outcome : { state: STATES.CONFIGURED, detail: outcome?.detail || 'Completed' };
      }
    }
  }

  /** Runs the whole flow in order and returns a per-step report. */
  async function run(options = {}) {
    const context = {
      options,
      promoted: options.promoted || {},
      credentials: options.credentials || {},
      snapshot: null,
      refresh: async () => {
        context.snapshot = await orchestrator.detectAll({ ...options, promoted: context.promoted });
        if (options.onRefresh) await options.onRefresh(context.snapshot);
        return context.snapshot;
      },
    };
    await context.refresh();

    const results = [];
    for (const step of STEPS) {
      log(`\n[${step.key}] ${step.label}`);
      let outcome;
      try {
        outcome = await runStep(step, context);
      } catch (error) {
        outcome = { state: STATES.FAILED, detail: String(error?.message || error).slice(0, 200), recovery: `Retry the "${step.label}" step.` };
      }
      results.push({ ...step, ...outcome });

      const succeeded = isSatisfied(outcome.state);
      if (!succeeded && step.required) {
        return {
          ok: false,
          failedStep: step.key,
          failedLabel: step.label,
          recovery: outcome.recovery || `Retry "${step.label}" from the installer menu.`,
          detail: outcome.detail,
          results,
          snapshot: context.snapshot,
        };
      }
      if (!succeeded) log(`  optional step skipped: ${outcome.detail}${outcome.recovery ? ` (${outcome.recovery})` : ''}`);
    }

    await context.refresh();
    return { ok: true, results, snapshot: context.snapshot };
  }

  return { run, STEPS, runStep };
}

module.exports = { createInstallationFlow, STEPS };
