/* Discover the real 3x-ui API paths by harvesting them from the
 * authenticated dashboard JS bundle.
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
  const loginBody = await loginRes.text();
  const sc = parseSetCookie(loginRes);
  if (sc) cookie = cookie ? `${cookie}; ${sc}` : sc;
  console.log('AUTHED login.status=' + loginRes.status + ' cookie="' + cookie.slice(0, 50) + '..."');
  if (loginBody.includes('"success":false')) {
    console.log('LOGIN REJECTED: ' + loginBody.slice(0, 150));
    process.exit(1);
  }

  const H = { Accept: 'text/html,application/json', Cookie: cookie };

  // Fetch dashboard pages and collect JS bundle URLs
  const candidates = ['/', '/panel/', '/panel', '/dashboard', '/xui/'];
  const bundleUrls = new Set();
  for (const p of candidates) {
    try {
      const r = await fetch(joinUrl(BASE, p), { method: 'GET', headers: H });
      const html = await r.text();
      console.log(`HTML ${p} => ${r.status} len=${html.length}`);
      const re = /\/assets\/[A-Za-z0-9._-]+\.js/g;
      let m;
      while ((m = re.exec(html)) !== null) bundleUrls.add(m[0]);
      const apiRe = /["'`](\/[a-zA-Z0-9/_-]*(?:server|inbound|client|setting|status)[a-zA-Z0-9/_-]*)["'`]/g;
      while ((m = apiRe.exec(html)) !== null) console.log('  API-REF: ' + m[1]);
    } catch (e) {
      console.log(`HTML ${p} => ERR ${e.message}`);
    }
  }
  console.log('\nBUNDLES found:', [...bundleUrls].length);

  // Download each bundle and harvest API paths
  const apiPaths = new Set();
  for (const b of bundleUrls) {
    try {
      const r = await fetch(joinUrl(BASE, b), { method: 'GET', headers: { Accept: '*/*' } });
      const js = await r.text();
      // Match quoted path strings containing api/server/inbound/client/setting/status
      const re = /["'`](\/[a-zA-Z0-9/_{}.-]*(?:api|server|inbound|client|setting|status|panel)[a-zA-Z0-9/_{}.-]*)["'`]/g;
      let m;
      while ((m = re.exec(js)) !== null) {
        const path = m[1];
        // Filter out asset paths and obvious non-API strings
        if (!path.includes('.js') && !path.includes('.css') && !path.includes('/assets/') && path.length > 4 && path.length < 80) {
          apiPaths.add(path);
        }
      }
    } catch {}
  }
  console.log('\n=== API PATH CANDIDATES ===');
  [...apiPaths].sort().forEach((p) => console.log(p));

  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
