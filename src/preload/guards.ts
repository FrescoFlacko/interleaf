import type { CloneableRecord, CloneableValue } from '@shared/models/portable';

/**
 * Structural helpers for the small preload payloads that have no shared wire
 * schema of their own. Payloads that do have one are validated with it in
 * `wire-guards.ts`. Main remains the authoritative boundary; these only stop a
 * malformed or oversized payload from reaching the renderer.
 */
export function isPlainRecord(value: CloneableValue): value is CloneableRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.prototype.toString.call(value) === '[object Object]';
}

export function hasOnlyKeys(value: CloneableRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
