const test = require('node:test');
const assert = require('node:assert/strict');
const { managedRules, mergeConfig, validateHostname } = require('./cloudflare-tunnel');

test('adds two managed hostnames before the catch-all and remains idempotent', () => {
  const source = 'tunnel: id\ncredentials-file: /root/id.json\ningress:\n  - hostname: old.example.com\n    service: http://127.0.0.1:1\n  - service: http_status:404\n';
  const rules = managedRules('panel.example.com', 'https://127.0.0.1:8000', 'sub.example.com', 'https://127.0.0.1:2096');
  const once = mergeConfig(source, rules);
  const twice = mergeConfig(once, rules);
  assert.equal(twice, once);
  assert.ok(once.indexOf('panel.example.com') < once.indexOf('http_status:404'));
  assert.match(once, /noTLSVerify: true/);
});

test('rejects labels and URLs instead of a fully-qualified hostname', () => {
  assert.throws(() => validateHostname('panel'));
  assert.throws(() => validateHostname('https://panel.example.com'));
});
