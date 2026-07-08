/* one-off: register the running 3x-ui (mhsanaei/Sanaei) panel at 127.0.0.1:2053
 * as a VpnPanel row so the SanityPanelClient integration is actually live.
 *
 * Why this script? The SanityPanelClient code is fully wired, but VpnService →
 * PanelsService.getConnection() needs a VpnPanel DB row to dispatch to. With no
 * row present (PANELS: []), provisioning silently has no target panel.
 *
 * Auth model: 3x-ui uses session-cookie + CSRF-token login (NOT apiKey). The
 * apiKey column is NOT NULL in the schema and PanelsService.getConnection()
 * calls decrypt(panel.apiKey), so we store an encrypted placeholder. The real
 * credentials live in metadata (extraConfig) and/or fall back to env
 * (SANITY_PANEL_USERNAME / SANITY_PANEL_PASSWORD).
 */
const crypto = require('node:crypto');

// ---- Replicate src/common/utils/crypto.util.ts encrypt() ----
const ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY || 'local-encryption-key-32byte!!2024';

function deriveKey() {
  return crypto.scryptSync(ENCRYPTION_KEY, 'vpn-saas-salt', 32);
}

function encrypt(plain) {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

// ---- Panel connection details (match .env SANITY_PANEL_*) ----
const BASE_URL = process.env.SANITY_PANEL_BASE_URL || 'http://127.0.0.1:2053';
const USERNAME = process.env.SANITY_PANEL_USERNAME || 'admin';
const PASSWORD = process.env.SANITY_PANEL_PASSWORD || 'adminadmin';

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const existing = await prisma.vpnPanel.findFirst({
    where: { baseUrl: BASE_URL, type: 'SANITY' },
  });
  if (existing) {
    console.log('PANEL_ALREADY_REGISTERED:', JSON.stringify({
      id: String(existing.id),
      name: existing.name,
      baseUrl: existing.baseUrl,
      status: existing.status,
    }, null, 2));
    await prisma.$disconnect();
    return;
  }

  const panel = await prisma.vpnPanel.create({
    data: {
      name: '3x-ui (mhsanaei) local',
      type: 'SANITY',
      baseUrl: BASE_URL,
      // Required by schema + decrypted by getConnection() at runtime; the
      // session-cookie client never uses it, so store an encrypted placeholder.
      apiKey: encrypt('sanity-session-auth'),
      status: 'ACTIVE',
      healthStatus: 'UNKNOWN',
      metadata: {
        username: USERNAME,
        password: PASSWORD,
        timeoutMs: Number(process.env.SANITY_PANEL_TIMEOUT_MS || 15000),
      },
    },
  });
  console.log('PANEL_REGISTERED:', JSON.stringify({
    id: String(panel.id),
    publicId: panel.publicId,
    name: panel.name,
    type: panel.type,
    baseUrl: panel.baseUrl,
    status: panel.status,
  }, null, 2));
  await prisma.$disconnect();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
