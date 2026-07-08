/**
 * Formatting helpers for the Telegram bot.
 *
 * Centralised so every flow renders traffic/dates/currency consistently and
 * so we never leak raw BigInts / ISO strings to users.
 */
import type { BotLocale } from './telegram.types';

/** Format a traffic byte count as a human string (e.g. "12.4 GB"). */
export function formatTraffic(bytes: bigint | string | number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '∞';
  const n = typeof bytes === 'bigint' ? bytes : BigInt(bytes);
  if (n < 0n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = Number(n);
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx++;
  }
  const digits = idx === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[idx]}`;
}

/** Format usage as "used / limit". */
export function formatUsage(used: bigint | string | null, limit: bigint | string | null): string {
  return `${formatTraffic(used)} / ${formatTraffic(limit)}`;
}

/** Percentage of traffic used (0-100), or null when unlimited. */
export function trafficPercent(used: bigint | string | null, limit: bigint | string | null): number | null {
  if (limit === null || limit === undefined) return null;
  const u = typeof used === 'bigint' ? used : BigInt(used ?? 0n);
  const l = typeof limit === 'bigint' ? limit : BigInt(limit);
  if (l === 0n) return 0;
  return Math.min(100, Number((u * 100n) / l));
}

/** Days remaining until expiry (rounded up, min 0). */
export function daysRemaining(expiresAt: Date | string | null | undefined): number | null {
  if (!expiresAt) return null;
  const d = typeof expiresAt === 'string' ? new Date(expiresAt) : expiresAt;
  const ms = d.getTime() - Date.now();
  if (ms <= 0) return 0;
  return Math.ceil(ms / 86_400_000);
}

const FA_DATE = new Intl.DateTimeFormat('fa-IR', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const EN_DATE = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** Format a date/time in the user's locale calendar. */
export function formatDate(date: Date | string | null | undefined, locale: BotLocale): string {
  if (!date) return '∞';
  const d = typeof date === 'string' ? new Date(date) : date;
  try {
    return locale === 'fa' ? FA_DATE.format(d) : EN_DATE.format(d);
  } catch {
    return d.toISOString();
  }
}

/** Short date (no time). */
const FA_DATE_SHORT = new Intl.DateTimeFormat('fa-IR', { year: 'numeric', month: '2-digit', day: '2-digit' });
const EN_DATE_SHORT = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: 'short', day: '2-digit' });

export function formatDateShort(date: Date | string | null | undefined, locale: BotLocale): string {
  if (!date) return '∞';
  const d = typeof date === 'string' ? new Date(date) : date;
  try {
    return locale === 'fa' ? FA_DATE_SHORT.format(d) : EN_DATE_SHORT.format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** Build a progress bar from a 0-100 percentage. */
export function progressBar(pct: number | null, width = 10): string {
  if (pct === null) return '∞';
  const p = Math.max(0, Math.min(100, pct));
  const filled = Math.round((p / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** Escape MarkdownV1 special characters inside inline code/text. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([_*`\[])/g, '\\$1');
}

/** Status emoji for subscription / payment / order states. */
export function statusEmoji(status: string | null | undefined): string {
  const s = (status ?? '').toUpperCase();
  switch (s) {
    case 'ACTIVE':
    case 'CONFIRMED':
    case 'COMPLETED':
    case 'PAID':
    case 'APPROVED':
    case 'OPEN':
      return '🟢';
    case 'TRIAL':
      return '🎁';
    case 'PENDING':
    case 'AWAITING_VERIFY':
    case 'INITIATED':
    case 'WAITING':
    case 'PROCESSING':
    case 'PENDING_USER':
    case 'PENDING_AGENT':
      return '🟡';
    case 'SUSPENDED':
    case 'PAUSED':
    case 'CONFIRMING':
    case 'REOPENED':
      return '🔵';
    case 'EXPIRED':
    case 'CANCELLED':
    case 'FAILED':
    case 'REJECTED':
    case 'CLOSED':
    case 'OFFLINE':
    case 'MAINTENANCE':
      return '🔴';
    case 'DEGRADED':
      return '🟠';
    default:
      return '⚪';
  }
}
