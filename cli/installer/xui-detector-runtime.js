const { exec } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

function requestWith(client, urlString, options = {}) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(urlString); } catch { resolve({ ok: false, error: 'invalid-url', statusCode: 0, headers: {}, body: '' }); return; }
    const secure = url.protocol === 'https:';
    const transport = secure ? client.https : client.http;
    const body = options.body || '';
    const request = transport.request({
      method: options.method || 'GET', hostname: url.hostname, port: url.port || (secure ? 443 : 80),
      path: `${url.pathname}${url.search}`, timeout: options.timeout || 7000,
      rejectUnauthorized: !options.insecure,
      headers: { Accept: 'application/json,text/html,*/*', 'User-Agent': 'tazaxy-installer/1.0', ...(options.headers || {}), ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => resolve({ ok: response.statusCode >= 200 && response.statusCode < 500, statusCode: response.statusCode || 0, headers: response.headers || {}, body: responseBody, error: null }));
    });
    request.on('error', (error) => resolve({ ok: false, error: error.message || String(error), statusCode: 0, headers: {}, body: '' }));
    request.on('timeout', () => request.destroy(new Error('request-timeout')));
    if (body) request.write(body);
    request.end();
  });
}

function createXuiDetectorRuntime(overrides = {}) {
  return {
    exec: overrides.exec || exec,
    fs: overrides.fs || fs,
    readSqliteSettings: overrides.readSqliteSettings,
    http: overrides.http || http,
    https: overrides.https || https,
    request: overrides.request || ((url, options) => requestWith({ http: overrides.http || http, https: overrides.https || https }, url, options)),
    now: overrides.now || (() => new Date()),
    loadState: overrides.loadState,
    saveState: overrides.saveState,
    cwd: overrides.cwd || (() => process.cwd()),
    path: overrides.path || path,
  };
}

module.exports = { createXuiDetectorRuntime, defaultXuiDetectorRuntime: createXuiDetectorRuntime() };
