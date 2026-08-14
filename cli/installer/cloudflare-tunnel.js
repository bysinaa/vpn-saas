'use strict';

const fs = require('fs');

const START = '  # tazaxy-managed-start';
const END = '  # tazaxy-managed-end';

function validateHostname(value) {
  const hostname = String(value || '').trim().toLowerCase();
  if (!/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) {
    throw new Error(`Invalid public hostname: ${value}`);
  }
  return hostname;
}

function normalizePublicUrls(panelValue, subscriptionValue, detectedPanelPath = '/') {
  const parse = (value, label) => {
    let url;
    try {
      const input = String(value || '').trim();
      url = new URL(input.includes('://') ? input : `https://${input}`);
    } catch {
      throw new Error(`Invalid ${label} public URL: ${value}`);
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) {
      throw new Error(`${label} public URL must be HTTPS with no credentials, port, query, or fragment`);
    }
    validateHostname(url.hostname);
    return url;
  };
  const panel = parse(panelValue, 'panel');
  const subscription = parse(subscriptionValue, 'subscription');
  if (panel.pathname === '/') {
    panel.pathname = `/${String(detectedPanelPath || '/').replace(/^\/+|\/+$/g, '')}`;
  }
  if (!panel.pathname.endsWith('/')) panel.pathname += '/';
  return {
    panelUrl: panel.toString(),
    panelHostname: panel.hostname,
    subscriptionBaseUrl: subscription.origin,
    subscriptionHostname: subscription.hostname,
  };
}

function discoverRoutes(source, panelOrigin, subscriptionOrigin) {
  const targetPort = (value) => {
    const url = new URL(value);
    return url.port || (url.protocol === 'https:' ? '443' : '80');
  };
  const panelPort = targetPort(panelOrigin);
  const subscriptionPort = targetPort(subscriptionOrigin);
  if (panelPort === subscriptionPort) return {};

  const routes = [];
  let hostname = '';
  for (const line of String(source).split(/\r?\n/)) {
    const hostMatch = line.match(/^\s*- hostname:\s*(\S+)\s*$/);
    if (hostMatch) {
      hostname = hostMatch[1];
      continue;
    }
    const serviceMatch = line.match(/^\s+service:\s*(https?:\/\/\S+)\s*$/);
    if (hostname && serviceMatch) {
      try {
        routes.push({
          hostname: validateHostname(hostname),
          service: serviceMatch[1],
          port: targetPort(serviceMatch[1]),
        });
      } catch {
        // Ignore unrelated or malformed operator-managed rules.
      }
      hostname = '';
    }
  }
  const panel = routes.find((route) => route.port === panelPort);
  const subscription = routes.find((route) => route.port === subscriptionPort);
  return {
    panelHostname: panel?.hostname,
    panelService: panel?.service,
    subscriptionHostname: subscription?.hostname,
    subscriptionService: subscription?.service,
  };
}

function managedRules(panelHostname, panelService, subscriptionHostname, subscriptionService) {
  const rule = (hostname, service) => [
    `  - hostname: ${validateHostname(hostname)}`,
    `    service: ${service}`,
    ...(String(service).startsWith('https://') ? ['    originRequest:', '      noTLSVerify: true'] : []),
  ];
  return [START, ...rule(panelHostname, panelService), ...rule(subscriptionHostname, subscriptionService), END];
}

function mergeConfig(source, rules) {
  let withoutOld = String(source).replace(new RegExp(`^${START}[\\s\\S]*?^${END}\\r?\\n?`, 'm'), '');
  const managedHostnames = rules.flatMap((line) => {
    const match = line.match(/^\s*- hostname:\s*(\S+)$/);
    return match ? [match[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')] : [];
  });
  for (const hostname of managedHostnames) {
    withoutOld = withoutOld.replace(
      new RegExp(`^  - hostname:\\s*${hostname}\\s*\\r?\\n(?:(?: {4}| {6}).*\\r?\\n)*`, 'gm'),
      '',
    );
  }
  const lines = withoutOld.trimEnd().split(/\r?\n/);
  const ingress = lines.findIndex((line) => /^ingress:\s*$/.test(line));
  if (ingress < 0) throw new Error('Cloudflare config has no ingress section');
  let catchAll = -1;
  for (let index = lines.length - 1; index > ingress; index -= 1) {
    if (/^\s{2}- service:\s*/.test(lines[index])) { catchAll = index; break; }
  }
  if (catchAll < 0) throw new Error('Cloudflare config has no final catch-all ingress rule');
  lines.splice(catchAll, 0, ...rules);
  return `${lines.join('\n')}\n`;
}

function updateFile(configPath, panelHostname, panelService, subscriptionHostname, subscriptionService) {
  const source = fs.readFileSync(configPath, 'utf8');
  const next = mergeConfig(source, managedRules(panelHostname, panelService, subscriptionHostname, subscriptionService));
  fs.writeFileSync(`${configPath}.tazaxy-new`, next, { mode: 0o600 });
  return `${configPath}.tazaxy-new`;
}

if (require.main === module) {
  try {
    process.stdout.write(`${updateFile(...process.argv.slice(2))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  discoverRoutes,
  managedRules,
  mergeConfig,
  normalizePublicUrls,
  updateFile,
  validateHostname,
};
