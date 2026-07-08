/* Diagnostic: replicate SanityPanelClient auth flow using node-fetch v2
 * (the SAME library the app uses) to determine which HTTP method and path
 * the Sanaei 3x-ui build expects for /panel/api/server/status.
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
  // 1) CSRF token
  const csrfRes = await fetch(joinUrl(BASE, '/csrf-token'), {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  const csrfBody = await csrfRes.json();
  if (!csrfBody.success || !csrfBody.obj) {
    console.log('CSRF_FAIL', JSON.stringify(csrfBody));
    process.exit(1);
  }
  const csrfToken = csrfBody.obj;
  let cookie = parseSetCookie(csrfRes);
  console.log('CSRF_OK token=' + csrfToken.slice(0, 8) + '... cookie="' + cookie + '"');

  // 2) Login (form-encoded) — node-fetch v2 does NOT follow redirects by default
  const form = new URLSearchParams();
  form.set('username', 'admin');
  form.set('password', 'admin');
  const loginRes = await fetch(joinUrl(BASE, '/login'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRF-Token': csrfToken,
      Cookie: cookie,
      Accept: 'application/json',
    },
    body: form.toString(),
  });
  const loginText = await loginRes.text();
  console.log('LOGIN status=' + loginRes.status + ' ct=' + (loginRes.headers.get('content-type') || '?') + ' len=' + loginText.length);
  let loginBody;
  try {
    loginBody = JSON.parse(loginText);
  } catch {
    console.log('LOGIN body (not json): ' + loginText.slice(0, 150));
    if (!loginRes.ok) process.exit(1);
    loginBody = { success: true, obj: null };
  }
  console.log('LOGIN body=' + JSON.stringify(loginBody).slice(0, 150));
  if (loginBody.success === false) {
    console.log('LOGIN_REJECTED');
    process.exit(1);
  }
  const sessionCookie = parseSetCookie(loginRes);
  if (sessionCookie) cookie = cookie ? `${cookie}; ${sessionCookie}` : sessionCookie;
  console.log('SESSION cookie="' + cookie.slice(0, 60) + '"');

  const baseHeaders = {
    Accept: 'application/json',
    'X-CSRF-Token': csrfToken,
    Cookie: cookie,
  };

  async function probe(method, path, withBody) {
    const headers = { ...baseHeaders };
    let body;
    if (withBody) {
      headers['Content-Type'] = 'application/json';
      body = '{}';
    }
    try {
      const r = await fetch(joinUrl(BASE, path), { method, headers, body });
      const t = await r.text();
      console.log(`${method.padEnd(4)} ${path}${withBody ? ' (json)' : ''} => HTTP ${r.status}  bytes=${t.length}  body=${t.slice(0, 160)}`);
    } catch (e) {
      console.log(`${method.padEnd(4)} ${path} => ERROR ${e.message}`);
    }
  }

  console.log('\n=== /panel/api/server/status ===');
  await probe('GET', '/panel/api/server/status', false);
  await probe('POST', '/panel/api/server/status', false);
  await probe('POST', '/panel/api/server/status', true);

  console.log('\n=== /server/status (alt path) ===');
  await probe('GET', '/server/status', false);
  await probe('POST', '/server/status', false);
  await probe('POST', '/server/status', true);

  console.log('\n=== /panel/api/inbounds/list ===');
  await probe('GET', '/panel/api/inbounds/list', false);
  await probe('POST', '/panel/api/inbounds/list', false);
  await probe('POST', '/panel/api/inbounds/list', true);

  console.log('\n=== /panel/api/setting/all ===');
  await probe('POST', '/panel/api/setting/all', true);

  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
