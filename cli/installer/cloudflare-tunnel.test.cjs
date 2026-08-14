const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  discoverRoutes,
  managedRules,
  mergeConfig,
  normalizePublicUrls,
  validateHostname,
} = require('./cloudflare-tunnel');

test('adds two managed hostnames before the catch-all and remains idempotent', () => {
  const source = 'tunnel: id\ncredentials-file: /root/id.json\ningress:\n  - hostname: old.example.com\n    service: http://127.0.0.1:1\n  - service: http_status:404\n';
  const rules = managedRules('panel.example.com', 'https://127.0.0.1:8000', 'sub.example.com', 'https://127.0.0.1:2096');
  const once = mergeConfig(source, rules);
  const twice = mergeConfig(once, rules);
  assert.equal(twice, once);
  assert.ok(once.indexOf('panel.example.com') < once.indexOf('http_status:404'));
  assert.match(once, /noTLSVerify: true/);
});

test('adopts matching operator routes without leaving duplicate hostnames', () => {
  const source = `tunnel: id
ingress:
  - hostname: api.mivezone.ir
    service: https://127.0.0.1:8000
    originRequest:
      noTLSVerify: true
  - hostname: sub.mivezone.ir
    service: https://127.0.0.1:2096
  - service: http_status:404
`;
  const next = mergeConfig(
    source,
    managedRules(
      'api.mivezone.ir',
      'https://127.0.0.1:8000/api/',
      'sub.mivezone.ir',
      'https://127.0.0.1:2096',
    ),
  );
  assert.equal(next.match(/hostname: api\.mivezone\.ir/g)?.length, 1);
  assert.equal(next.match(/hostname: sub\.mivezone\.ir/g)?.length, 1);
});

test('rejects labels and URLs instead of a fully-qualified hostname', () => {
  assert.throws(() => validateHostname('panel'));
  assert.throws(() => validateHostname('https://panel.example.com'));
});

test('discovers existing panel and subscription hostnames from their origin ports', () => {
  const source = `tunnel: id
ingress:
  - hostname: api.mivezone.ir
    service: https://127.0.0.1:8000
  - hostname: sub.mivezone.ir
    service: https://127.0.0.1:2096
  - service: http_status:404
`;
  assert.deepEqual(
    discoverRoutes(source, 'https://127.0.0.1:8000/api/', 'https://127.0.0.1:2096'),
    {
      panelHostname: 'api.mivezone.ir',
      panelService: 'https://127.0.0.1:8000',
      subscriptionHostname: 'sub.mivezone.ir',
      subscriptionService: 'https://127.0.0.1:2096',
    },
  );
});

test('does not guess route roles when panel and subscription share a port', () => {
  assert.deepEqual(
    discoverRoutes(
      'ingress:\n  - hostname: panel.example.com\n    service: https://127.0.0.1:443\n  - service: http_status:404\n',
      'https://127.0.0.1:443/api/',
      'https://127.0.0.1:443',
    ),
    {},
  );
});

test('accepts the two public URLs and keeps the detected panel path', () => {
  assert.deepEqual(
    normalizePublicUrls('https://api.example.com', 'https://sub.example.com/sub/', '/api/'),
    {
      panelUrl: 'https://api.example.com/api/',
      panelHostname: 'api.example.com',
      subscriptionBaseUrl: 'https://sub.example.com',
      subscriptionHostname: 'sub.example.com',
    },
  );
  assert.equal(
    normalizePublicUrls('https://panel.example.com/custom/', 'https://sub.example.com', '/api/').panelUrl,
    'https://panel.example.com/custom/',
  );
  assert.deepEqual(
    normalizePublicUrls('api.mivezone.ir', 'sub.mivezone.ir', '/api/'),
    {
      panelUrl: 'https://api.mivezone.ir/api/',
      panelHostname: 'api.mivezone.ir',
      subscriptionBaseUrl: 'https://sub.mivezone.ir',
      subscriptionHostname: 'sub.mivezone.ir',
    },
  );
  assert.throws(() => normalizePublicUrls('http://panel.example.com', 'https://sub.example.com'));
});

test('Linux workflow installs cloudflared and asks for both public links', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'setup-cloudflare-xui.sh'), 'utf8');
  assert.match(script, /cloudflare\/cloudflared\/releases\/latest\/download\/cloudflared-linux-\$cloudflared_arch/);
  assert.match(script, /Panel public URL/);
  assert.match(script, /Subscription public base URL/);
  assert.doesNotMatch(script, /--zones-from-cert|Cloudflare base domain|Panel subdomain/);
});
