'use strict';

const fs = require('fs');
const path = require('path');

function readJson(file, runtime) {
  try {
    return runtime.fs.existsSync(file) ? JSON.parse(runtime.fs.readFileSync(file, 'utf8')) : null;
  } catch {
    return null;
  }
}

function readDatabase(file, runtime) {
  try {
    if (!runtime.fs.existsSync(file)) return null;
    const line = String(runtime.fs.readFileSync(file, 'utf8'))
      .split(/\r?\n/)
      .find((item) => /^\s*DATABASE_URL\s*=/.test(item));
    const value = line?.replace(/^\s*DATABASE_URL\s*=\s*/, '').replace(/^['"]|['"]$/g, '');
    const url = new URL(value);
    if (!/^postgres(?:ql)?:$/.test(url.protocol)) return null;
    return {
      configured: true,
      host: url.hostname,
      port: Number(url.port || 5432),
      database: decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres',
      source: 'environment',
    };
  } catch {
    return null;
  }
}

function readCanonicalRuntime(options = {}) {
  const runtime = {
    fs: options.fs || fs,
    path: options.path || path,
    cwd: options.cwd || process.cwd(),
  };
  const config = readJson(runtime.path.join(runtime.cwd, '.tazaxy', 'config.json'), runtime) || {};
  const legacy = readJson(runtime.path.join(runtime.cwd, 'installer-state.json'), runtime) || {};
  return {
    config,
    legacy,
    database: readDatabase(runtime.path.join(runtime.cwd, '.env'), runtime),
  };
}

function isLoopback(host) {
  return ['localhost', '127.0.0.1', '::1'].includes(String(host || '').toLowerCase());
}

function reachableUrl(value, publicIp) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (isLoopback(url.hostname)) {
      if (!publicIp) return null;
      url.hostname = publicIp;
    }
    return url.toString();
  } catch {
    return value;
  }
}

function detectedApplicationUrl(detectedUrl, persistedUrl, publicIp) {
  if (!detectedUrl) return reachableUrl(persistedUrl, publicIp);
  try {
    const detected = new URL(detectedUrl);
    if (isLoopback(detected.hostname)) {
      const persistedHost = persistedUrl ? new URL(persistedUrl).hostname : null;
      detected.hostname = persistedHost || publicIp || detected.hostname;
    }
    return detected.toString();
  } catch {
    return reachableUrl(detectedUrl, publicIp);
  }
}

function resolveCanonicalPanel(config = {}, detection = {}) {
  const persisted = config.panel;
  const detectedPanel = detection?.data?.panel;
  const detectedSubscription = detection?.data?.subscription;
  const publicIp = config.app?.publicIp;
  const panelUrl = detectedApplicationUrl(detectedPanel?.url, persisted?.panelUrl, publicIp);
  const subscriptionHost = detectedSubscription?.host || publicIp || detectedPanel?.host;
  const detectedSubscriptionBase = detectedSubscription?.port && subscriptionHost
    ? `${detectedSubscription.scheme || 'http'}://${subscriptionHost}:${detectedSubscription.port}`
    : null;
  const subscriptionBase = detectedApplicationUrl(detectedSubscriptionBase, persisted?.subscriptionBaseUrl, publicIp);
  const subscriptionPath = detectedSubscription?.path || persisted?.subscriptionPath || '/sub/';
  return {
    configured: Boolean(persisted?.panelUrl),
    authenticated: Boolean(persisted?.panelUrl),
    panelUrl,
    subscriptionUrl: subscriptionBase
      ? `${reachableUrl(subscriptionBase, publicIp).replace(/\/+$/, '')}/${String(subscriptionPath).replace(/^\/+|\/+$/g, '')}/`
      : null,
    subscriptionPort: detectedSubscription?.port ?? persisted?.subscriptionPort ?? null,
    subscriptionPath: String(subscriptionPath).replace(/^\/+|\/+$/g, '') || 'sub',
    hostProbePanelUrl: detectedPanel?.url || null,
    hostProbeSubscriptionUrl: detectedSubscription?.port
      ? `${detectedSubscription.scheme || 'http'}://${detectedSubscription.host}:${detectedSubscription.port}${detectedSubscription.path || '/sub/'}`
      : null,
  };
}

function deriveDiscoveryState(canonical, dockerState = {}) {
  const panel = resolveCanonicalPanel(canonical.config);
  const appHealthy = dockerState.appContainerHealthy === true;
  return {
    databaseDiscovered: Boolean(canonical.database || canonical.legacy?.db?.discovered),
    panelDetected: panel.configured || canonical.legacy?.xui?.detected === true || dockerState.xuiContainerRunning === true,
    panelConfirmed: panel.configured || Boolean(canonical.legacy?.xui?.confirmed),
    healthChecked: appHealthy || Boolean(canonical.legacy?.health),
    healthOverall: appHealthy ? 'healthy' : canonical.legacy?.health?.value?.overall,
  };
}

function diagnosisFailureMessage(appRunning, detail) {
  return appRunning
    ? `App-container diagnosis failed while the application container is running${detail ? `: ${detail}` : '.'}`
    : 'App-container diagnosis is unavailable because the application container is not running.';
}

module.exports = {
  deriveDiscoveryState,
  diagnosisFailureMessage,
  isLoopback,
  readCanonicalRuntime,
  resolveCanonicalPanel,
};
