#!/usr/bin/env node
/**
 * register-to-saas.js
 *
 * Purpose:
 *  - Register the local panel (confirmed in installer-state.json) with a remote SaaS
 *    registration endpoint, capture returned credentials, and persist them into
 *    installer-state.json under xui.remoteRegistration.
 *
 * Usage:
 *   node cli/installer/register-to-saas.js [--saas-url=https://saas.example/api/panels/register] [--insecure]
 *
 * Environment:
 *   SAAS_REGISTRATION_URL - fallback URL if --saas-url not provided
 *
 * Notes:
 *  - No external dependencies. Uses built-in http/https modules.
 *  - If --insecure is provided, TLS certificate verification will be skipped.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const STATE_PATH = path.resolve(process.cwd(), 'installer-state.json');

function parseArgs() {
  const out = { saasUrl: null, insecure: false };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--saas-url=')) out.saasUrl = a.split('=')[1];
    if (a === '--insecure') out.insecure = true;
  }
  if (!out.saasUrl && process.env.SAAS_REGISTRATION_URL) out.saasUrl = process.env.SAAS_REGISTRATION_URL;
  return out;
}

const _stateManager = require('./state-manager');
const loadState = () => _stateManager.loadState(STATE_PATH);
const saveState = (s) => _stateManager.saveState(STATE_PATH, s);

function httpPostJson(urlString, body, insecure = false) {
  return new Promise((resolve, reject) => {
    try {
      const urlObj = new URL(urlString);
      const payload = JSON.stringify(body || {});
      const opts = {
        method: 'POST',
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + (urlObj.search || ''),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent': 'tazaxy-installer/1.0',
        },
        timeout: 15000,
      };

      // Support basic TLS insecure mode by providing an agent that disables verification
      if (urlObj.protocol === 'https:') {
        opts.agent = new https.Agent({ rejectUnauthorized: !insecure });
      }

      const client = urlObj.protocol === 'https:' ? https : http;
      const req = client.request(opts, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const result = {
            statusCode: res.statusCode,
            headers: res.headers,
            body: data,
          };
          // Try to parse JSON body
          try {
            result.json = data ? JSON.parse(data) : null;
          } catch (e) {
            result.json = null;
            result.parseError = e.message;
          }
          resolve(result);
        });
      });

      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy(new Error('request-timeout'));
      });

      req.write(payload);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

(async function main() {
  const CLI = parseArgs();
  if (!CLI.saasUrl) {
    console.error('No SaaS registration URL provided. Pass --saas-url or set SAAS_REGISTRATION_URL env var.');
    process.exit(3);
  }

  const state = loadState();
  const baseUrl = (state.xui && state.xui.confirmed && state.xui.confirmed.baseUrl) || (state.xui && state.xui.selected && state.xui.selected.url);
  if (!baseUrl) {
    console.error('No confirmed panel base URL found in installer-state.json. Run detect and confirm first.');
    process.exit(4);
  }

  console.log('Registering local panel with SaaS at:', CLI.saasUrl);
  console.log('Local panel base URL:', baseUrl);

  const payload = {
    baseUrl,
    timestamp: new Date().toISOString(),
    metadata: {
      detected: !!state.xui && !!state.xui.detected,
      localHostInfo: state.hostInfo || null,
    },
  };

  let result;
  try {
    result = await httpPostJson(CLI.saasUrl, payload, !!CLI.insecure);
  } catch (e) {
    console.error('Registration request failed:', e && e.message ? e.message : e);
    // record failure in state
    state.xui = state.xui || {};
    state.xui.remoteRegistration = {
      timestamp: new Date().toISOString(),
      saasUrl: CLI.saasUrl,
      request: payload,
      error: e && e.message ? e.message : String(e),
    };
    saveState(state);
    process.exit(1);
  }

  state.xui = state.xui || {};
  state.xui.remoteRegistration = {
    timestamp: new Date().toISOString(),
    saasUrl: CLI.saasUrl,
    request: payload,
    response: {
      statusCode: result.statusCode,
      headers: result.headers,
      bodySnippet: (result.body || '').substring(0, 2000),
      parseError: result.parseError || null,
      json: result.json || null,
    },
  };

  // If SaaS returned credentials or panel info, store under credentials
  if (result.json && (result.json.panelId || result.json.secret || result.json.clientSecret || result.json.credentials)) {
    state.xui.remoteRegistration.credentials = result.json;
  }

  // Mark completed stage
  state.completedStages = state.completedStages || [];
  if (!state.completedStages.includes('xui_remote_registered')) state.completedStages.push('xui_remote_registered');

  saveState(state);

  console.log('SaaS registration result saved to installer-state.json');
  if (state.xui.remoteRegistration && state.xui.remoteRegistration.credentials) {
    console.log('Credentials received and recorded (trimmed):', JSON.stringify(state.xui.remoteRegistration.credentials, null, 2));
  } else {
    console.log('No credentials present in SaaS response. Check installer-state.json -> xui.remoteRegistration.response.json for details.');
  }

  process.exit(0);
})();