'use strict';

/**
 * Runs every detector automatically, before any question is asked, and keeps a
 * live snapshot that the CLI menu renders from.
 *
 * Two invariants matter here:
 *  1. A snapshot is always produced by running detectors *now*. Nothing is ever
 *     served from persisted installer state, so a stale file can never make a
 *     component look `CONFIGURED`.
 *  2. A detector that throws becomes FAILED with a recovery action. Optional
 *     components can therefore never terminate the installation.
 */

const { createEnvironmentDetector } = require('./environment-detector');
const { createXuiRuntimeDetector } = require('./xui-runtime-detector');
const { createTelegramDetector } = require('./telegram-detector');
const { STATES, format, isBlocking, isSatisfied, result } = require('./detection-states');

const COMPONENTS = Object.freeze([
  { key: 'system', label: 'Operating system & privileges', optional: false },
  { key: 'docker', label: 'Docker & Compose', optional: false },
  { key: 'tazaxy', label: 'Existing Tazaxy installation', optional: true },
  { key: 'postgres', label: 'PostgreSQL', optional: false },
  { key: 'xui', label: '3X-UI panel', optional: false },
  { key: 'containers', label: 'App / Redis / MinIO containers', optional: true },
  { key: 'env', label: 'Environment file (.env)', optional: false },
  { key: 'telegram', label: 'Telegram Bot', optional: false },
]);

function createDetectionOrchestrator({ runtime, detectors } = {}) {
  const environment = detectors?.environment || createEnvironmentDetector({ runtime });
  const xui = detectors?.xui || createXuiRuntimeDetector({ runtime });
  const telegram = detectors?.telegram || createTelegramDetector({ runtime });

  /** Wraps a detector so a throw becomes FAILED rather than a crash. */
  async function safely(component, optional, probe) {
    try {
      const detection = await probe();
      return { ...detection, component, optional: optional || detection.optional === true };
    } catch (error) {
      return result(component, STATES.FAILED, {
        optional,
        detail: String(error?.message || error).slice(0, 200),
        recovery: `Retry the "${component}" step from the menu; installation can continue without it.`,
      });
    }
  }

  /**
   * Runs all detectors. `options.detected` may carry results already promoted
   * in this session (for example a panel promoted to CONNECTED after the user
   * supplied credentials) so a refresh does not lose a verified connection.
   */
  async function detectAll(options = {}) {
    const promoted = options.promoted || {};
    const detections = {};

    const probes = {
      system: () => environment.detectSystem(),
      docker: () => environment.detectDocker(),
      tazaxy: () => environment.detectExistingInstallation(options),
      postgres: () => environment.detectPostgres(options),
      xui: () => xui.discover(options),
      containers: () => environment.detectContainers(),
      env: () => environment.detectEnvFile(options),
      telegram: () => telegram.detect(options),
    };

    for (const { key, optional } of COMPONENTS) {
      const detection = await safely(key, optional, probes[key]);
      // A session-verified CONNECTED result is authoritative: it was proven by a
      // real authenticated call, which read-only discovery cannot reproduce.
      const promotion = promoted[key];
      detections[key] =
        promotion && promotion.state === STATES.CONNECTED
          ? { ...promotion, data: { ...detection.data, ...promotion.data }, observedAt: detection.observedAt }
          : detection;
    }

    return summarize(detections);
  }

  function summarize(detections) {
    const components = COMPONENTS.map(({ key, label, optional }) => ({
      key,
      label,
      optional,
      ...(detections[key] || result(key, STATES.NOT_FOUND, { optional })),
    }));
    const required = components.filter((component) => !component.optional);
    const blocking = required.filter((component) => isBlocking(component.state));
    const needsCredentials = components.filter((component) => component.state === STATES.NEEDS_CREDENTIALS);
    const failed = components.filter((component) => component.state === STATES.FAILED);

    return {
      detections,
      components,
      ready: blocking.length === 0,
      blocking,
      needsCredentials,
      failed,
      satisfied: components.filter((component) => isSatisfied(component.state)),
      observedAt: new Date().toISOString(),
    };
  }

  /** Renders the detection summary; used by the menu header and the flow. */
  function render(snapshot, { color = true } = {}) {
    const width = Math.max(...snapshot.components.map((component) => component.label.length));
    const lines = snapshot.components.map((component) => {
      const label = component.label.padEnd(width);
      const optional = component.optional ? ' (optional)' : '';
      const detail = component.detail ? ` — ${component.detail}` : '';
      return `  ${label}  ${format(component.state, { color })}${optional}${detail}`;
    });
    if (snapshot.needsCredentials.length > 0 || snapshot.failed.length > 0) {
      lines.push('');
      for (const component of [...snapshot.needsCredentials, ...snapshot.failed]) {
        if (component.recovery) lines.push(`  ! ${component.label}: ${component.recovery}`);
      }
    }
    return lines.join('\n');
  }

  return { detectAll, summarize, render, COMPONENTS };
}

module.exports = { createDetectionOrchestrator, COMPONENTS };
