'use strict';

const { createXuiDetectorRuntime } = require('./xui-detector-runtime');

function redactDiagnostic(error) { return String(error || 'validation-failed').replace(/(?:password|token|cookie)=[^\s&]+/ig, '$1=[REDACTED]').slice(0, 160); }

function createXuiCredentialValidator({ runtime: overrides } = {}) {
  const runtime = createXuiDetectorRuntime(overrides);

  async function validate({ connection, username, password, insecure = false, onValidated }) {
    if (!connection?.url || !username || !password) return { status: 'ERROR', diagnostics: [{ code: 'MISSING_CREDENTIALS', detail: 'Username and password are required.' }], recommendedAction: 'Enter credentials through hidden interactive input.' };
    const base = connection.url.replace(/\/$/, '');
    const body = new URLSearchParams({ username, password }).toString();
    try {
      const login = await runtime.request(`${base}/login`, { method: 'POST', body, insecure, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      const success = login.statusCode >= 200 && login.statusCode < 400 && !/invalid|incorrect|failed/i.test(login.body || '');
      if (!success) return { status: 'ERROR', diagnostics: [{ code: login.statusCode === 401 || login.statusCode === 403 ? 'AUTH_FAILED' : 'LOGIN_REJECTED', statusCode: login.statusCode || 0 }], recommendedAction: 'Verify credentials and panel URL.' };
      const health = await runtime.request(`${base}/panel/api/inbounds/list`, { insecure, headers: { Cookie: Array.isArray(login.headers?.['set-cookie']) ? login.headers['set-cookie'][0].split(';')[0] : '' } });
      if (health.statusCode >= 500 || health.statusCode === 0) return { status: 'PARTIAL', diagnostics: [{ code: 'READ_ONLY_HEALTH_FAILED', statusCode: health.statusCode || 0 }], recommendedAction: 'Check panel permissions before registration.' };
      if (onValidated) await onValidated({ username, password });
      return { status: 'FOUND', diagnostics: [{ code: 'CREDENTIALS_VALIDATED', statusCode: login.statusCode }], recommendedAction: 'Credentials may now be encrypted and persisted by the installer adapter.' };
    } catch (error) { return { status: 'ERROR', diagnostics: [{ code: 'VALIDATION_ERROR', detail: redactDiagnostic(error) }], recommendedAction: 'Check connectivity and TLS settings.' }; }
  }

  async function promptAndValidate(input) {
    if (!runtime.promptHidden) throw new Error('Hidden credential prompting is unavailable in this runtime');
    const username = input.username || await runtime.promptHidden('XUI username', { secret: false });
    const password = await runtime.promptHidden('XUI password', { secret: true });
    return validate({ ...input, username, password });
  }

  async function importLocalSqliteCredentials({ authorized = false, readLocalCredentials, ...input }) {
    if (!authorized || !readLocalCredentials) return { status: 'ERROR', diagnostics: [{ code: 'LOCAL_IMPORT_NOT_AUTHORIZED' }], recommendedAction: 'Explicitly authorize local SQLite credential import.' };
    const credential = await readLocalCredentials();
    return validate({ ...input, username: credential?.username, password: credential?.password });
  }

  async function validateExistingEncrypted({ loadEncryptedCredential, ...input }) {
    if (!loadEncryptedCredential) return { status: 'ERROR', diagnostics: [{ code: 'ENCRYPTED_CREDENTIAL_UNAVAILABLE' }], recommendedAction: 'Enter credentials through hidden interactive input.' };
    const credential = await loadEncryptedCredential();
    return validate({ ...input, username: credential?.username, password: credential?.password });
  }

  return { validate, promptAndValidate, importLocalSqliteCredentials, validateExistingEncrypted };
}

module.exports = { createXuiCredentialValidator };
