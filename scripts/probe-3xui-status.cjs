/* Diagnostic: replicate the SanityPanelClient auth flow against 3x-ui
 * directly in Node, then probe /panel/api/server/status with BOTH GET and POST
 * to determine which HTTP method the Sanaei build expects.
 */
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
  console.log('CSRF_OK token=' + csrfToken.slice(0, 8) + '... cookie=' + cookie.slice(0, 30));

  // 2) Login (form-encoded)
  const form = new URLSearchParams();
  form.set('username', 'admin');
  form.set('password', 'admin');
  const loginRes = await fetch(joinUrl(BASE, '/login'), {
    method: 'POST',
    redirect: 'manual', // mirror node-fetch default (no redirect follow)
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRF-Token': csrfToken,
      Cookie: cookie,
      Accept: 'application/json',
    },
    body: form.toString(),
  });
  const loginText = await loginRes.text();
  console.log('LOGIN_RAW status=' + loginRes.status + ' ct=' + (loginRes.headers.get('content-type') || '?') + ' len=' + loginText.length);
  let loginBody;
  try {
    loginBody = JSON.parse(loginText);
  } catch {
    console.log('LOGIN_BODY_NOT_JSON: ' + loginText.slice(0, 150));
    // Some builds respond 200 with empty body on success; proceed if status ok.
    if (!loginRes.ok) {
      console.log('LOGIN_HTTP_FAIL status=' + loginRes.status);
      process.exit(1);
    }
    loginBody = { success: true, obj: null };
  }
  if (loginBody.success === false) {
    console.log('LOGIN_FAIL', JSON.stringify(loginBody));
    process.exit(1);
  }
  const sessionCookie = parseSetCookie(loginRes);
  if (sessionCookie) cookie = cookie ? `${cookie}; ${sessionCookie}` : sessionCookie;
  console.log('LOGIN_OK cookie=' + cookie.slice(0, 40));

  const headers = {
    Accept: 'application/json',
    'X-CSRF-Token': csrfToken,
    Cookie: cookie,
  };

  // 3a) GET /panel/api/server/status
  try {
    const r = await fetch(joinUrl(BASE, '/panel/api/server/status'), { method: 'GET', headers });
    const t = await r.text();
    console.log(`GET  server/status => HTTP ${r.status}  bytes=${t.length}  body=${t.slice(0, 120)}`);
  } catch (e) {
    console.log('GET  server/status => ERROR', e.message);
  }

  // 3b) POST /panel/api/server/status
  try {
    const r = await fetch(joinUrl(BASE, '/panel/api/server/status'), { method: 'POST', headers });
    const t = await r.text();
    console.log(`POST server/status => HTTP ${r.status}  bytes=${t.length}  body=${t.slice(0, 120)}`);
  } catch (e) {
    console.log('POST server/status => ERROR', e.message);
  }

  // 3c) POST /panel/api/server/status WITH json body (some builds need {})
  try {
    const r = await fetch(joinUrl(BASE, '/panel/api/server/status'), {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const t = await r.text();
    console.log(`POST server/status (json) => HTTP ${r.status}  bytes=${t.length}  body=${t.slice(0, 120)}`);
  } catch (e) {
    console.log('POST server/status (json) => ERROR', e.message);
  }
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
