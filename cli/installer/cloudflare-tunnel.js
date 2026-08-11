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

function managedRules(panelHostname, panelService, subscriptionHostname, subscriptionService) {
  const rule = (hostname, service) => [
    `  - hostname: ${validateHostname(hostname)}`,
    `    service: ${service}`,
    ...(String(service).startsWith('https://') ? ['    originRequest:', '      noTLSVerify: true'] : []),
  ];
  return [START, ...rule(panelHostname, panelService), ...rule(subscriptionHostname, subscriptionService), END];
}

function mergeConfig(source, rules) {
  const withoutOld = String(source).replace(new RegExp(`^${START}[\\s\\S]*?^${END}\\r?\\n?`, 'm'), '');
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

module.exports = { managedRules, mergeConfig, updateFile, validateHostname };
