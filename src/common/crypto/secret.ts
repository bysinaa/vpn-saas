/**
 * secret.ts
 *
 * Minimal AES-256-GCM helper for encrypting/decrypting short secrets.
 *
 * Behavior:
 * - Uses env var SECRETS_KEY as symmetric key material; the key is derived with SHA-256.
 * - secretEncrypt(plaintext) -> returns base64(iv|tag|ciphertext)
 * - secretDecrypt(payload) -> returns plaintext
 *
 * Notes:
 * - This is intentionally small and self-contained. For production consider
 *   integrating with a KMS (AWS KMS, GCP KMS, HashiCorp Vault) instead of an
 *   env var-derived key.
 */
import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_ENV = 'SECRETS_KEY';

function deriveKey(key: string): Buffer {
  return crypto.createHash('sha256').update(String(key), 'utf8').digest();
}

/**
 * Encrypts a UTF-8 string and returns base64(iv|tag|ciphertext)
 */
export function secretEncrypt(plaintext: string): string {
  const key = process.env[KEY_ENV];
  if (!key) {
    throw new Error(`${KEY_ENV} is not set`);
  }
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, deriveKey(key), iv, { authTagLength: TAG_LEN });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/**
 * Decrypts base64(iv|tag|ciphertext) and returns UTF-8 plaintext
 */
export function secretDecrypt(payload: string): string {
  const key = process.env[KEY_ENV];
  if (!key) {
    throw new Error(`${KEY_ENV} is not set`);
  }
  const buf = Buffer.from(payload, 'base64');
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('invalid payload');
  }
  const iv = buf.slice(0, IV_LEN);
  const tag = buf.slice(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.slice(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGORITHM, deriveKey(key), iv, {
    authTagLength: TAG_LEN,
  });
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return decrypted;
}
