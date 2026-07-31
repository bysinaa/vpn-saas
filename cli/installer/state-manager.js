'use strict';
/**
 * state-manager.js
 *
 * Helper to load/save installer-state.json with optional redaction and optional
 * AES-256-GCM encryption using an environment key INSTALLER_STATE_KEY.
 *
 * Usage:
 *   const { loadState, saveState } = require('./state-manager');
 *   const state = loadState(STATE_PATH);
 *   // modify state...
 *   saveState(STATE_PATH, state);
 *
 * Behavior:
 * - If file contents start with "ENC:" the rest is base64(iv|tag|ciphertext) and
 *   will be decrypted using INSTALLER_STATE_KEY. If the key is missing decryption
 *   will fail.
 * - If env var INSTALLER_STATE_KEY is present when saving, file will be written
 *   encrypted (prefixed with "ENC:").
 * - If env var REDACT_INSTALLER_STATE is truthy, sensitive fields will be
 *   redacted before persisting (replacing values with "[REDACTED]").
 *
 * Notes:
 * - This is designed to be a minimal, opt-in safety layer to avoid leaking
 *   credentials into plain JSON. It preserves backward compatibility (plain JSON)
 *   when no key is configured.
 */
const fs = require('fs');
const crypto = require('crypto');
const util = require('util');

const ENC_PREFIX = 'ENC:';
const KEY_ENV = 'INSTALLER_STATE_KEY';
const REDACT_ENV = 'REDACT_INSTALLER_STATE';

// Crypto parameters
const ALGORITHM = 'aes-256-gcm';
const IV_LEN = 12; // recommended for GCM
const TAG_LEN = 16;

function deriveKey(key) {
  // Derive 32-byte key via SHA256 of provided secret
  return crypto.createHash('sha256').update(String(key), 'utf8').digest();
}

function encryptString(plaintext, key) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, deriveKey(key), iv, { authTagLength: TAG_LEN });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Store as base64(iv | tag | ciphertext)
  const payload = Buffer.concat([iv, tag, ciphertext]).toString('base64');
  return ENC_PREFIX + payload;
}

function decryptString(payloadWithPrefix, key) {
  if (!payloadWithPrefix.startsWith(ENC_PREFIX)) {
    throw new Error('Invalid encrypted payload');
  }
  const payload = Buffer.from(payloadWithPrefix.slice(ENC_PREFIX.length), 'base64');
  if (payload.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('Encrypted payload too short');
  }
  const iv = payload.slice(0, IV_LEN);
  const tag = payload.slice(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = payload.slice(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGORITHM, deriveKey(key), iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return decrypted;
}

function isObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

function redactSecrets(obj, keyRegex = /password|secret|token|cookie|jwt|credential/i) {
  // Deep clone and redact values whose keys match keyRegex
  if (Array.isArray(obj)) {
    return obj.map((v) => redactSecrets(v, keyRegex));
  }
  if (!isObject(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (keyRegex.test(k)) {
      // Redact entire value
      out[k] = '[REDACTED]';
      continue;
    }
    // Specific sensitive paths: raw outputs and credentials commonly produced by installer
    if (k === 'rawOutput' || k === 'rawLine') {
      out[k] = '[REDACTED]';
      continue;
    }
    // Recurse
    out[k] = redactSecrets(v, keyRegex);
  }
  return out;
}

function tryParseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function loadState(statePath) {
  try {
    if (!fs.existsSync(statePath)) return {};
    const raw = fs.readFileSync(statePath, 'utf8').trim();
    if (!raw) return {};
    if (raw.startsWith(ENC_PREFIX)) {
      const key = process.env[KEY_ENV];
      if (!key) {
        throw new Error(`State file is encrypted but ${KEY_ENV} is not set`);
      }
      const json = decryptString(raw, key);
      return tryParseJsonSafe(json) || {};
    } else {
      // Plain JSON
      return tryParseJsonSafe(raw) || {};
    }
  } catch (e) {
    // Preserve previous behavior for scripts: on read failure, some scripts expect to exit or handle.
    // Here we bubble the error so callers can decide.
    throw e;
  }
}

function saveState(statePath, state) {
  try {
    const doRedact = !!process.env[REDACT_ENV];
    let toWriteObj = state;
    if (doRedact) {
      // Only redact a copy
      toWriteObj = redactSecrets(state);
    }

    const plaintext = JSON.stringify(toWriteObj, null, 2);
    const key = process.env[KEY_ENV];
    if (key) {
      const encrypted = encryptString(plaintext, key);
      fs.writeFileSync(statePath, encrypted, 'utf8');
    } else {
      fs.writeFileSync(statePath, plaintext, 'utf8');
    }
  } catch (e) {
    // Bubble up so callers can log and exit as appropriate
    throw e;
  }
}

module.exports = {
  loadState,
  saveState,
  // exported for tests / debugging
  _internals: {
    encryptString,
    decryptString,
    redactSecrets,
  },
};