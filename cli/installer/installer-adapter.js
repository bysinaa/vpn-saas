'use strict';

const crypto = require('crypto');
const path = require('path');
const { loadState, saveState } = require('./state-manager');

function sanitized(result) {
  const copy = JSON.parse(JSON.stringify(result));
  const redact = (value) => {
    if (!value || typeof value !== 'object') return value;
    for (const [key, nested] of Object.entries(value)) {
      if (/password|secret|token|cookie|credential|databaseurl/i.test(key)) value[key] = '[REDACTED]';
      else redact(nested);
    }
    return value;
  };
  return redact(copy);
}

function defaultEncrypt(value) {
  const key = process.env.INSTALLER_CREDENTIAL_KEY;
  if (!key) throw new Error('INSTALLER_CREDENTIAL_KEY is required before panel credentials can be persisted');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(key).digest(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return `ENC:${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')}`;
}

function createInstallerAdapter(deps = {}) {
  const statePath = deps.statePath || path.resolve(process.cwd(), 'installer-state.json');
  const readState = deps.loadState || (() => loadState(statePath));
  const writeState = deps.saveState || ((state) => saveState(statePath, state));
  const encrypt = deps.encrypt || defaultEncrypt;

  async function persistDetection(kind, result) {
    const state = await readState() || {};
    state.detections = state.detections || {};
    const next = sanitized(result);
    const current = state.detections[kind];
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      state.detections[kind] = next;
      await writeState(state);
    }
    return next;
  }

  async function registerValidatedPanel({ detection, username, password, registerPanel, ensureBinding, syncInbounds }) {
    if (!detection?.connection || !username || !password) throw new Error('Validated panel metadata and in-memory credentials are required');
    const encryptedCredential = encrypt({ username, password });
    const panel = await registerPanel({ connection: detection.connection, encryptedCredential, source: detection.source });
    const binding = await ensureBinding({ panel, connection: detection.connection });
    const synchronization = await syncInbounds({ panel, binding });
    await persistDetection('xui', detection);
    return { panel, binding, synchronization };
  }

  return { persistDetection, registerValidatedPanel };
}

module.exports = { createInstallerAdapter, sanitized };
