'use strict';

// Auth client only. Read-only installation discovery lives in xui-runtime-detector.
const { createXuiDetectorRuntime } = require('./xui-detector-runtime');

function redact(value) { return String(value || '').replace(/(?:password|token|cookie)=[^\s&]+/ig, '$1=[REDACTED]').slice(0, 160); }

function createXuiDetector({ runtime: overrides } = {}) {
  const runtime = createXuiDetectorRuntime(overrides);

  async function validate(target = {}, credentials = {}, options = {}) {
    const connection = target.connection || target;
    if (!connection?.url) return { authenticated: false, apiReachable: false, configured: false, diagnostics: [{ code: 'NO_CANDIDATE' }] };
    const root = connection.url.replace(/\/$/, '');
    const username = credentials.username;
    const password = credentials.password;
    if (!username || !password) return { authenticated: false, apiReachable: false, configured: false, diagnostics: [{ code: 'CREDENTIALS_REQUIRED' }] };

    const jar = new Map();
    const collect = (response) => [].concat(response.headers?.['set-cookie'] || []).forEach((raw) => {
      const pair = String(raw).split(';')[0]; const index = pair.indexOf('=');
      if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
    });
    const headers = () => ({ 'X-Requested-With': 'XMLHttpRequest', Origin: new URL(root).origin, Referer: `${root}/`, ...(jar.size ? { Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; ') } : {}) });
    const request = (url, requestOptions) => runtime.request(url, { insecure: !!options.insecure, timeout: options.timeout || 8000, ...requestOptions });

    const csrf = await request(`${root}/csrf-token`, { method: 'GET', headers: headers() });
    collect(csrf);
    let csrfToken;
    try { const body = JSON.parse(csrf.body || '{}'); csrfToken = body.success && typeof body.obj === 'string' ? body.obj : null; } catch { csrfToken = null; }
    const login = await request(`${root}/login`, { method: 'POST', body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`, headers: { ...headers(), 'Content-Type': 'application/x-www-form-urlencoded', ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) } });
    collect(login);
    let loggedIn = false;
    try { loggedIn = JSON.parse(login.body || '{}').success === true; } catch { /* not logged in */ }
    if (!loggedIn) return { authenticated: false, apiReachable: false, configured: false, diagnostics: [{ code: 'LOGIN_FAILED', detail: `HTTP ${login.statusCode || 0}` }] };

    const api = await request(`${root}/panel/api/inbounds/list`, { method: 'GET', headers: headers() });
    try {
      const body = JSON.parse(api.body || '{}');
      if (body.success === true) return { authenticated: true, apiReachable: true, configured: true, inbounds: Array.isArray(body.obj) ? body.obj.length : 0, observedAt: runtime.now().toISOString(), diagnostics: [] };
    } catch { /* API failed */ }
    return { authenticated: true, apiReachable: false, configured: false, diagnostics: [{ code: 'API_UNREACHABLE', detail: redact(`HTTP ${api.statusCode || 0}`) }] };
  }

  return { validate };
}

module.exports = { createXuiDetector };
