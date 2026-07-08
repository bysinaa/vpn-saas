/* Discover the real 3x-ui v2 API prefix by probing many path variants
 * with an authenticated node-fetch session (same lib the app uses).
 */
const fetch = require('node-fetch');
const BASE = 'http://127.0.0.1:2053';

function parseSetCookie(res) {
  try {
    const raw = res.headers.raw()['set-cookie'];
    if (!raw || raw.length === 0) return '';
    return raw.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  } catch {
    return '';
  }
}
function joinUrl(base, path) {
  return base.replace(/\/$/, '') + path;
}

(async () => {
  // Auth
  const csrfRes = await fetch(joinUrl(BASE, '/csrf-token'), { method: 'GET', headers: { Accept: 'application/json' } });
  const csrfBody = await csrfRes.json();
  const csrfToken = csrfBody.obj;
  let cookie = parseSetCookie(csrfRes);
  const form = new URLSearchParams({ username: 'admin', password: 'admin' });
  const loginRes = await fetch(joinUrl(BASE, '/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': csrfToken, Cookie: cookie, Accept: 'application/json' },
    body: form.toString(),
  });
  const sc = parseSetCookie(loginRes);
  if (sc) cookie = cookie ? `${cookie}; ${sc}` : sc;
  console.log('AUTHED status=' + loginRes.status);

  const H = { Accept: 'application/json', 'X-CSRF-Token': csrfToken, Cookie: cookie, 'Content-Type': 'application/json' };

  // Path variants to probe — list inbounds (read-only, safe)
  const probes = [
    // classic paths
    'GET  /panel/api/inbounds/list',
    'POST /panel/api/inbounds/list',
    // v2 without /api/
    'GET  /panel/inbounds/list',
    'POST /panel/inbounds/list',
    'GET  /panel/inbounds',
    'POST /panel/inbounds',
    // /api/ prefix
    'GET  /api/inbounds/list',
    'POST /api/inbounds/list',
    'GET  /api/inbounds',
    'POST /api/inbounds',
    // /api/panel/
    'GET  /api/panel/inbounds/list',
    'POST /api/panel/inbounds/list',
    // direct
    'GET  /inbounds/list',
    'POST /inbounds/list',
    'GET  /inbounds',
    'POST /inbounds',
    // onlines/get (common in v2)
    'POST /panel/api/inbounds/onlines',
    'POST /panel/inbounds/onlines',
    // setting/all variants
    'POST /panel/api/setting/all',
    'POST /panel/setting/all',
    'POST /api/setting/all',
    'POST /setting/all',
  ];

  for (const probe of probes) {
    // "GET  /path" or "POST /path" — split on whitespace, 2 parts max
    const parts = probe.trim().split(/\s+/);
    const method = parts[0];
    const path = parts.slice(1).join(' ');
    const withBody = method === 'POST';
    try {
      const r = await fetch(joinUrl(BASE, path), {
        method,
        headers: H,
        body: withBody ? '{}' : undefined,
      });
      const t = await r.text();
      const tag = r.status === 200 ? '*** 200 ***' : `HTTP ${r.status}`;
      console.log(`${probe.padEnd(42)} => ${tag}  bytes=${String(t.length).padStart(5)}  ${t.slice(0, 80).replace(/\n/g, ' ')}`);
    } catch (e) {
      console.log(`${probe.padEnd(42)} => ERR ${e.message}`);
    }
  }
  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
