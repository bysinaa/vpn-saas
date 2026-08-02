'use strict';
/**
 * state-manager.js
 *
 * Helper to load/save installer-state.json with:
 *  - Optional AES-256-GCM encryption (INSTALLER_STATE_KEY)
 *  - Optional secret redaction (REDACT_INSTALLER_STATE)
 *  - **State validation**: timestamps, source, confidence, expiration
 *  - **Cached entry validation**: before using a cached value, validate it;
 *    if invalid (expired, missing, low-confidence), signal rediscovery.
 *
 * Entry format (for any cacheable value):
 *   {
 *     value: <any>,              // the cached value
 *     source: string,            // where it came from: 'auto-detect' | 'cli' | 'envfile' | 'docker' | ...
 *     confidence: 'high' | 'medium' | 'low',  // how reliable is this value
 *     timestamp: ISO string,     // when it was set
 *     expiresAt: ISO string|null,// when it becomes stale (null = never expires)
 *     validationStatus: 'valid' | 'stale' | 'invalid' | 'unknown'
 *   }
 *
 * Usage:
 *   const { loadState, saveState, setEntry, getValidatedEntry, validateState } = require('./state-manager');
 *   const state = loadState(STATE_PATH);
 *   setEntry(state, 'xui.confirmed', { baseUrl: 'http://...' }, { source: 'auto-detect', confidence: 'high', ttlSeconds: 3600 });
 *   const entry = getValidatedEntry(state, 'xui.confirmed');
 *   if (!entry) { // rediscover }
 *   saveState(STATE_PATH, state);
 */
const fs = require('fs');
const crypto = require('crypto');

const ENC_PREFIX = 'ENC:';
const KEY_ENV = 'INSTALLER_STATE_KEY';
const REDACT_ENV = 'REDACT_INSTALLER_STATE';

// Default TTLs (in seconds)
const DEFAULT_TTL = {
  high: 3600,      // 1 hour for high-confidence entries
  medium: 1800,    // 30 minutes for medium-confidence
  low: 300,        // 5 minutes for low-confidence
};

// Crypto parameters
const ALGORITHM = 'aes-256-gcm';
const IV_LEN = 12; // recommended for GCM
const TAG_LEN = 16;

function deriveKey(key) {
  return crypto.createHash('sha256').update(String(key), 'utf8').digest();
}

function encryptString(plaintext, key) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, deriveKey(key), iv, { authTagLength: TAG_LEN });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
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
  if (Array.isArray(obj)) {
    return obj.map((v) => redactSecrets(v, keyRegex));
  }
  if (!isObject(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (keyRegex.test(k)) {
      out[k] = '[REDACTED]';
      continue;
    }
    if (k === 'rawOutput' || k === 'rawLine') {
      out[k] = '[REDACTED]';
      continue;
    }
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

// ── State validation helpers ───────────────────────────────────────

/**
 * Resolve a dot-separated path (e.g. 'xui.confirmed.baseUrl') to its parent object and final key.
 * Returns { parent, key, exists } or null if path is invalid.
 */
function resolvePath(obj, dotPath) {
  const parts = dotPath.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!isObject(current[k])) {
      current[k] = {};
    }
    current = current[k];
  }
  return { parent: current, key: parts[parts.length - 1] };
}

/**
 * Set a validated cache entry at a dot-separated path.
 * @param {object} state - the state object (mutated in place)
 * @param {string} dotPath - e.g. 'xui.confirmed'
 * @param {any} value - the value to cache
 * @param {object} opts - { source, confidence, ttlSeconds, expiresAt }
 */
function setEntry(state, dotPath, value, opts = {}) {
  const { parent, key } = resolvePath(state, dotPath);
  const now = new Date();
  const confidence = opts.confidence || 'medium';
  const ttlSeconds = opts.ttlSeconds != null ? opts.ttlSeconds : DEFAULT_TTL[confidence];

  const entry = {
    value,
    source: opts.source || 'unknown',
    confidence,
    timestamp: now.toISOString(),
    expiresAt: ttlSeconds > 0 ? new Date(now.getTime() + ttlSeconds * 1000).toISOString() : null,
    validationStatus: 'valid',
  };

  parent[key] = entry;
  return entry;
}

/**
 * Get a cache entry at a dot-separated path, but only if it's still valid.
 * If the entry is expired or missing, returns null (signaling rediscovery needed).
 * Also updates validationStatus on the entry.
 * @param {object} state - the state object
 * @param {string} dotPath - e.g. 'xui.confirmed'
 * @param {object} opts - { minConfidence, allowExpired }
 * @returns {object|null} - the entry object, or null if invalid/missing
 */
function getValidatedEntry(state, dotPath, opts = {}) {
  const parts = dotPath.split('.');
  let current = state;
  for (const k of parts) {
    if (!isObject(current) || !(k in current)) return null;
    current = current[k];
  }

  // If it's not an entry object (no timestamp), treat as raw value — return as-is with 'unknown' status
  if (!isObject(current) || !current.timestamp) {
    return { value: current, source: 'unknown', confidence: 'unknown', timestamp: null, expiresAt: null, validationStatus: 'unknown' };
  }

  const now = new Date();
  const expiresAt = current.expiresAt ? new Date(current.expiresAt) : null;

  // Check expiration
  if (expiresAt && now > expiresAt) {
    current.validationStatus = 'stale';
    if (!opts.allowExpired) return null;
  } else {
    current.validationStatus = 'valid';
  }

  // Check confidence threshold
  const minConfidence = opts.minConfidence || 'low';
  const confidenceOrder = { low: 0, medium: 1, high: 2 };
  const entryConfidence = confidenceOrder[current.confidence] != null ? confidenceOrder[current.confidence] : 0;
  const requiredConfidence = confidenceOrder[minConfidence] != null ? confidenceOrder[minConfidence] : 0;
  if (entryConfidence < requiredConfidence) {
    current.validationStatus = 'invalid';
    return null;
  }

  return current;
}

/**
 * Validate the entire state object. Returns a report of which entries are valid/stale/invalid.
 * @param {object} state
 * @returns {object} - { valid: string[], stale: string[], invalid: string[], unknown: string[] }
 */
function validateState(state) {
  const report = { valid: [], stale: [], invalid: [], unknown: [] };

  function walk(obj, path) {
    if (!isObject(obj)) return;
    for (const [k, v] of Object.entries(obj)) {
      const currentPath = path ? `${path}.${k}` : k;
      if (isObject(v) && v.timestamp && v.source) {
        // This is a cache entry
        const now = new Date();
        const expiresAt = v.expiresAt ? new Date(v.expiresAt) : null;
        if (expiresAt && now > expiresAt) {
          v.validationStatus = 'stale';
          report.stale.push(currentPath);
        } else if (v.validationStatus === 'invalid') {
          report.invalid.push(currentPath);
        } else {
          v.validationStatus = 'valid';
          report.valid.push(currentPath);
        }
      } else if (isObject(v)) {
        walk(v, currentPath);
      } else if (v != null) {
        report.unknown.push(currentPath);
      }
    }
  }

  walk(state, '');
  return report;
}

/**
 * Purge all stale entries from state (sets them to null).
 * Returns list of purged paths.
 */
function purgeStale(state) {
  const purged = [];

  function walk(obj, path) {
    if (!isObject(obj)) return;
    for (const [k, v] of Object.entries(obj)) {
      const currentPath = path ? `${path}.${k}` : k;
      if (isObject(v) && v.timestamp && v.expiresAt) {
        const expiresAt = new Date(v.expiresAt);
        if (new Date() > expiresAt) {
          obj[k] = null;
          purged.push(currentPath);
        }
      } else if (isObject(v)) {
        walk(v, currentPath);
      }
    }
  }

  walk(state, '');
  return purged;
}

// ── Load / Save ────────────────────────────────────────────────────

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
      return tryParseJsonSafe(raw) || {};
    }
  } catch (e) {
    throw e;
  }
}

function saveState(statePath, state) {
  try {
    const doRedact = !!process.env[REDACT_ENV];
    let toWriteObj = state;
    if (doRedact) {
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
    throw e;
  }
}

module.exports = {
  loadState,
  saveState,
  setEntry,
  getValidatedEntry,
  validateState,
  purgeStale,
  resolvePath,
  // exported for tests / debugging
  _internals: {
    encryptString,
    decryptString,
    redactSecrets,
    DEFAULT_TTL,
  },
};