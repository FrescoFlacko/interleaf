import { boundedSerializedErrorSchema } from '../schemas/agent';
import type { PortableMember, PortableRecord, PortableValue } from '../models/portable';

/**
 * Read-only support for agent error events persisted before the Interleaf
 * rename.
 *
 * A serialized `InterleafError` carries a marker key so a plain object is not
 * mistaken for one. That key used to be `__marginlabError`; every write now
 * produces `__interleafError` only. Agent sessions are durable history, so a
 * session recorded before the rename still holds the legacy marker and would
 * otherwise fail validation on read and take the whole session detail with it.
 *
 * The normalization here is deliberately exact: only the marker key is
 * rewritten, and the result is then validated by the current bounded schema —
 * the same code/message length limits and the same bounded-extras rule. A
 * lookalike that does not satisfy those rules is returned untouched, so it is
 * rejected downstream instead of being coerced into a trusted error value.
 */

/** Marker key written by the current serializer. */
const SERIALIZED_ERROR_MARKER = '__interleafError' as const;
/** Marker key found in agent events recorded before the rename. */
const LEGACY_SERIALIZED_ERROR_MARKER = '__marginlabError' as const;

/**
 * Returns `event` with a legacy error payload normalized to the current
 * marker, or `event` unchanged when there is nothing exact to normalize.
 */
export function normalizeLegacyStoredAgentEvent(event: PortableValue): PortableValue {
  if (!isPlainRecord(event)) return event;
  const error: PortableMember = event.error;
  if (!isPlainRecord(error) || error[LEGACY_SERIALIZED_ERROR_MARKER] !== true) return event;
  // A payload carrying both markers is contradictory unless they agree; never
  // let the rewrite paper over a current marker that says otherwise.
  if (SERIALIZED_ERROR_MARKER in error && error[SERIALIZED_ERROR_MARKER] !== true) return event;

  const extras = Object.fromEntries(
    Object.entries(error).filter(([key]) => key !== LEGACY_SERIALIZED_ERROR_MARKER),
  );
  const parsed = boundedSerializedErrorSchema.safeParse({
    ...extras,
    [SERIALIZED_ERROR_MARKER]: true,
  });
  if (!parsed.success) return event;
  return { ...event, error: parsed.data };
}

function isPlainRecord(value: PortableMember): value is PortableRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
