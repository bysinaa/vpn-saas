'use strict';

/**
 * Telegram Bot configuration detection and validation.
 *
 * Rules enforced here:
 *  - the token is never printed, logged, returned or embedded in an error;
 *  - only a token accepted by `getMe` is ever written to .env;
 *  - a token present in .env is CONFIGURED, never CONNECTED — CONNECTED is
 *    reserved for a token this process has just validated against Telegram.
 */

const { createXuiDetectorRuntime } = require('./xui-detector-runtime');
const { STATES, result } = require('./detection-states');

const TOKEN_SHAPE = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;
const PLACEHOLDERS = new Set(['', 'change-me', 'changeme', 'your-bot-token', 'xxx', 'todo']);

function parseEnv(text) {
  return Object.fromEntries(
    String(text || '')
      .split(/\r?\n/)
      .flatMap((line) => {
        const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*?)\s*$/);
        return match ? [[match[1], match[2].replace(/^['"]|['"]$/g, '')]] : [];
      }),
  );
}

/** Strips anything that looks like a bot token out of free-form text. */
function redactToken(text) {
  return String(text || '')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_TOKEN]')
    .slice(0, 200);
}

function isWellFormed(token) {
  const value = String(token || '').trim();
  return !PLACEHOLDERS.has(value.toLowerCase()) && TOKEN_SHAPE.test(value);
}

function createTelegramDetector({ runtime: overrides } = {}) {
  const runtime = createXuiDetectorRuntime(overrides);
  const now = () => runtime.now();
  const read = (file) => {
    try {
      return runtime.fs.existsSync(file) ? runtime.fs.readFileSync(file, 'utf8') : null;
    } catch {
      return null;
    }
  };

  /**
   * Reads TELEGRAM_BOT_TOKEN from .env and reports shape only. No network call
   * is made here, so this can never report CONNECTED.
   */
  async function detect(options = {}) {
    try {
      const file = options.envPath || runtime.path.resolve(runtime.cwd(), '.env');
      const content = read(file);
      if (content === null) {
        return result('telegram', STATES.NOT_FOUND, { now, data: { envPath: file }, detail: 'No .env file, so no bot token is configured' });
      }
      const token = String(parseEnv(content).TELEGRAM_BOT_TOKEN || '').trim();
      const data = { envPath: file, hasToken: token.length > 0 };
      if (!token) {
        return result('telegram', STATES.NOT_FOUND, {
          now,
          data,
          detail: 'TELEGRAM_BOT_TOKEN is not set',
          recovery: 'Provide a bot token from @BotFather; it is required.',
        });
      }
      if (!isWellFormed(token)) {
        return result('telegram', STATES.FAILED, {
          now,
          data,
          detail: 'TELEGRAM_BOT_TOKEN is present but malformed',
          recovery: 'Replace it with a valid token from @BotFather.',
        });
      }
      return result('telegram', STATES.CONFIGURED, {
        now,
        data,
        detail: 'A well-formed bot token is configured (not yet verified with Telegram)',
        recovery: 'Validate it to promote the bot to CONNECTED.',
      });
    } catch (error) {
      return result('telegram', STATES.FAILED, { now, detail: redactToken(error), recovery: 'Check read permissions on the .env file.' });
    }
  }

  /**
   * Calls Telegram `getMe`. Returns CONNECTED with the bot username, or
   * NEEDS_CREDENTIALS when Telegram rejects the token. The token itself never
   * appears in the returned object.
   */
  async function validateToken(token, options = {}) {
    const value = String(token || '').trim();
    if (!isWellFormed(value)) {
      return result('telegram', STATES.NEEDS_CREDENTIALS, {
        now,
        detail: 'The supplied bot token is malformed',
        recovery: 'Copy the full token from @BotFather, in the form 123456789:AA...',
      });
    }
    try {
      const response = await runtime.request(`https://api.telegram.org/bot${value}/getMe`, { method: 'GET', timeout: options.timeout || 15000 });
      let payload = {};
      try {
        payload = JSON.parse(response.body || '{}');
      } catch {
        payload = {};
      }
      if (payload.ok !== true || !payload.result) {
        return result('telegram', STATES.NEEDS_CREDENTIALS, {
          now,
          data: { httpStatus: response.statusCode || 0 },
          detail: `Telegram rejected the token (HTTP ${response.statusCode || 0})`,
          recovery: 'Verify the token with @BotFather and enter it again.',
        });
      }
      const bot = payload.result;
      return result('telegram', STATES.CONNECTED, {
        now,
        data: { username: bot.username, botId: bot.id, firstName: bot.first_name, canJoinGroups: bot.can_join_groups === true },
        detail: `Bot @${bot.username} validated with getMe`,
      });
    } catch (error) {
      return result('telegram', STATES.FAILED, {
        now,
        detail: redactToken(error),
        recovery: 'Check outbound HTTPS access to api.telegram.org, then retry.',
      });
    }
  }

  return { detect, validateToken };
}

module.exports = { createTelegramDetector, isWellFormed, redactToken };
