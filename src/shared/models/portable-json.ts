import type { PortableValue } from './portable';

/**
 * Reading JSON text into the portable domain.
 *
 * `PortableValue` claims the exact set of values that survive a JSON text and a
 * SQLite JSON column round trip, and callers rely on that claim: a portable
 * value is expected to come back unchanged from `JSON.stringify`. `JSON.parse`
 * on its own does not honour it. An overflowing exponent such as `1e400` parses
 * to `Infinity`, which re-serializes as `null`, so a value that entered as a
 * number would silently leave as nothing. `NaN` cannot be written in JSON text
 * but can still be reached the same way, through underflow-free arithmetic on a
 * parsed value, so finiteness is checked rather than assumed.
 *
 * `CloneableValue` is deliberately not narrowed this way: an Electron
 * structured clone does carry non-finite numbers faithfully, so nothing there
 * is lost.
 */

/**
 * Reads JSON text as portable data.
 *
 * `JSON.parse` is declared to return `any`, which would let unchecked values
 * spread through typed code. This is the one place that states the portable
 * contract and enforces the part of it `JSON.parse` does not; callers still
 * have to narrow or validate before trusting the result.
 *
 * Text outside the domain is rejected the same way malformed text is, with a
 * `SyntaxError`, so every caller's existing parse-failure path already covers
 * it.
 */
export function parsePortableJson(text: string): PortableValue {
  const parsed = JSON.parse(text) as PortableValue;
  if (!isJsonDomainValue(parsed)) {
    throw new SyntaxError('JSON text held a number outside the portable domain.');
  }
  return parsed;
}

/** True when the value and every member below it round-trip through JSON. */
function isJsonDomainValue(value: PortableValue): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || value === null) return true;
  const members: readonly PortableValue[] = Array.isArray(value) ? value : Object.values(value);
  return members.every((member) => isJsonDomainValue(member));
}
