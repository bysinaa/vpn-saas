/* eslint-disable no-console */
/**
 * Diagnostic: probe Telegram getUpdates (the long-poll call) through the
 * configured SOCKS5 proxy, mimicking Telegraf's real polling (timeout:50).
 * Run ONLY when the bot is stopped (no competing getUpdates consumer).
 *
 * Run: node scripts/test-poll.js
 */
const BOT_TOKEN = (require('dotenv').config().parsed).TELEGRAM_BOT_TOKEN;
const PROXY_URL = (require('dotenv').config().parsed).PROXY_URL;

function timed(label, p) {
  const t = Date.now();
  return p.then(
    (v) => { console.log(`[OK ${(Date.now() - t) / 1000}s] ${label}: ${String(v).slice(0, 120)}`); return v; },
    (e) => { console.log(`[FAIL ${(Date.now() - t) / 1000}s] ${label}: ${e.message}`); },
  );
}

async function probeProxyLongPoll() {
  const { SocksProxyAgent } = await import('socks-proxy-agent');
  const agent = new SocksProxyAgent(PROXY_URL);
  const nodeFetch = (await import('node-fetch')).default;
  // Mimic Telegraf: getUpdates with timeout:50, no offset (fresh). Abort after 60s.
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?timeout=30`;
  return timed('PROXY getUpdates(timeout=30, long-poll)', nodeFetch(url, { agent }).then((r) => r.text()));
}

async function probeProxyShort() {
  const { SocksProxyAgent } = await import('socks-proxy-agent');
  const agent = new SocksProxyAgent(PROXY_URL);
  const nodeFetch = (await import('node-fetch')).default;
  return timed('PROXY getMe (short)', nodeFetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`, { agent }).then((r) => r.text()));
}

(async () => {
  console.log('--- Telegram connectivity probe (bot MUST be stopped) ---');
  await probeProxyShort();
  await probeProxyLongPoll();
  console.log('--- done ---');
  process.exit(0);
})().catch((e) => {
  console.error('probe crashed', e);
  process.exit(1);
});
