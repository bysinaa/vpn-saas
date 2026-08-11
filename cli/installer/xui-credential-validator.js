'use strict';

const { createXuiDetectorRuntime } = require('./xui-detector-runtime');
const { createXuiDetector } = require('./xui-detector');

function redactDiagnostic(error) { return String(error || 'validation-failed').replace(/(?:password|token|cookie)=[^\s&]+/ig, '$1=[REDACTED]').slice(0, 160); }

function createXuiCredentialValidator({ runtime: overrides } = {}) {
  const runtime = createXuiDetectorRuntime(overrides);
  // Auth lives in the detector: 3x-ui requires a CSRF token on unsafe methods and
  // answers a failed login with HTTP 200 + {"success":false}, so a status code proves nothing.
  const detector = createXuiDetector({ runtime: overrides });

  async function validate({ connection, username, password, insecure = false, timeout, onValidated }) {
    if (!connection?.url || !username || !password) return { status: 'ERROR', diagnostics: [{ code: 'MISSING_CREDENTIALS', detail: 'Username and password are required.' }], recommendedAction: 'Enter credentials through hidden interactive input.' };
    try {
      const result = await detector.validate({ connection }, { username, password }, { insecure, timeout });
      if (!result.authenticated) return { status: 'ERROR', diagnostics: [{ code: 'AUTH_FAILED', detail: 'The panel rejected the supplied credentials.' }], recommendedAction: 'Verify credentials and panel URL.' };
      if (!result.apiReachable) return { status: 'PARTIAL', diagnostics: [{ code: 'READ_ONLY_HEALTH_FAILED' }], recommendedAction: 'Check panel permissions before registration.' };
      if (onValidated) await onValidated({ username, password });
      return { status: 'FOUND', diagnostics: [{ code: 'CREDENTIALS_VALIDATED' }], recommendedAction: 'Credentials may now be encrypted and persisted by the installer adapter.' };
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
