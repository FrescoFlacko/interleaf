import type { PortableValue } from './portable';

/**
 * Cycle detection for portable data.
 *
 * A reference cycle is not portable: neither `JSON.stringify` nor the bounded
 * event guards can carry one, and a recursive schema descends into it forever.
 * The check therefore runs before portable data is parsed, at the one place
 * that accepts open-ended input, rather than at every boundary that reads it.
 */

/** True when no object repeats on the value's own reference path. */
export function isAcyclicPortableValue(value: PortableValue, active = new WeakSet<object>()): boolean {
  if (typeof value !== 'object' || value === null) return true;
  if (active.has(value)) return false;
  active.add(value);
  try {
    const members: readonly PortableValue[] = Array.isArray(value) ? value : Object.values(value);
    return members.every((member) => isAcyclicPortableValue(member, active));
  } catch {
    // A getter or proxy that throws during the walk fails closed, for the same
    // reason a cycle does: the value cannot be carried across a boundary.
    return false;
  } finally {
    // Only the active path is tracked. A repeated reference is safe to carry;
    // a cycle is what re-enters an object already on the path.
    active.delete(value);
  }
}
