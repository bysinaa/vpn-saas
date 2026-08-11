/**
 * Money utilities. All amounts are stored as BigInt "minor units" (cents
 * for USD, rials for IRR, etc). This avoids floating-point rounding bugs.
 *
 * Display conversion happens only at the edge (API/bot output).
 */

export type MinorUnits = bigint;

/** Convert a decimal string (e.g. "12.50") to minor units BigInt. */
export function toMinor(decimal: string | number, decimals = 2): MinorUnits {
  const [whole, frac = ''] = String(decimal).split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const negative = whole.trim().startsWith('-');
  const clean = whole.replace(/[^0-9]/g, '');
  const value = BigInt(clean) * 10n ** BigInt(decimals) + BigInt(fracPadded || '0');
  return negative ? -value : value;
}

/** Convert minor units back to a display decimal string. */
export function fromMinor(minor: MinorUnits, decimals = 2): string {
  const base = 10n ** BigInt(decimals);
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = frac.toString().padStart(decimals, '0');
  const sign = negative ? '-' : '';
  return `${sign}${whole}.${fracStr}`;
}

export function addMoney(...amounts: MinorUnits[]): MinorUnits {
  return amounts.reduce((acc, v) => acc + v, 0n);
}

export function subMoney(a: MinorUnits, b: MinorUnits): MinorUnits {
  return a - b;
}

export function isSufficient(balance: MinorUnits, required: MinorUnits): boolean {
  return balance >= required;
}

/** Apply a discount percent (0-100) returning the discounted amount. */
export function applyDiscount(amount: MinorUnits, percent: number): MinorUnits {
  if (percent <= 0) return amount;
  if (percent >= 100) return 0n;
  const factor = BigInt(Math.round(percent * 1000));
  const discounted = (amount * (100000n - factor)) / 100000n;
  return discounted;
}

export const ZERO = 0n;
