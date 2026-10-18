/**
 * The portable transport domain.
 *
 * `PortableValue` is the exact set of values that survive a `JSON.parse` of
 * provider or CLI output and a SQLite JSON column round trip. It is the
 * declared type of data that has crossed such a boundary but has not been
 * validated yet: narrowing it to a domain model still requires a guard or a
 * Zod schema, so it carries no authority of its own.
 *
 * `undefined` is not one of these values. JSON has no way to write it, so a
 * member that was absent before a round trip is absent after it; reading a key
 * that is not there still answers `undefined`, which is what the optional
 * member of a validated model then describes. Data on its way through an
 * Electron structured clone, which does carry `undefined`, is
 * `CloneableValue` below.
 *
 * It is deliberately not a replacement for a domain model. Once a payload has
 * been validated, it must be described by its own named type; only genuinely
 * open-ended data (unvalidated input, opaque provider metadata, structured log
 * details) stays portable.
 */
export type PortableValue =
  | string
  | number
  | boolean
  | null
  | readonly PortableValue[]
  | PortableRecord;

/**
 * A portable value as read out of a record: the value, or nothing at all where
 * the key is absent. Reading `record[key]` cannot promise the key is there, so
 * every guard and coercion that inspects an unvalidated member takes this and
 * answers for the absent case as well.
 */
export type PortableMember = PortableValue | undefined;

/** The leaf values of portable data: everything that is not an array or a record. */
export type PortablePrimitive = string | number | boolean | null;

/** A plain object carrying portable values, as produced by `JSON.parse`. */
export type PortableRecord = { readonly [key: string]: PortableValue };

/**
 * The structured-clone transport domain: what crosses an Electron IPC channel.
 *
 * A structured clone keeps `undefined`, so a request whose optional member was
 * never set arrives with that member present and undefined, and a pushed
 * payload may carry the same. That is the one difference from `PortableValue`,
 * and the reason this is a separate type rather than a wider portable one:
 * everything portable is cloneable, while cloneable data has to have its
 * absent members dropped before it can be written as JSON.
 */
export type CloneableValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly CloneableValue[]
  | CloneableRecord;

/** A plain object carrying cloneable values, as produced by a structured clone. */
export type CloneableRecord = { readonly [key: string]: CloneableValue };

/**
 * A portable record being built. Assign into it, then hand it on as a
 * `PortableRecord` once it is complete.
 */
export type PortableRecordDraft = Record<string, PortableValue>;

/**
 * Portable data that a redaction or normalization pass rewrites in place,
 * mutable all the way down. It is assignable to `PortableValue`, so a rewritten
 * payload can be handed on as ordinary portable data once the pass is done.
 */
export type MutablePortableValue =
  | string
  | number
  | boolean
  | null
  | MutablePortableValue[]
  | MutablePortableRecord;

/** A plain object whose portable members are rewritten in place. */
export type MutablePortableRecord = { [key: string]: MutablePortableValue };

/** `PortableMember` for data a rewriting pass still owns. */
export type MutablePortableMember = MutablePortableValue | undefined;

/**
 * Narrows a portable value to a plain record.
 *
 * `Array.isArray` does not remove a `readonly` array from a union, so this is
 * the shared way to tell the two object shapes apart.
 */
export function isPortableRecord(value: PortableMember): value is PortableRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrows a portable value to an array.
 *
 * `Array.isArray` widens a `readonly` array member to `any[]`, which would put
 * unchecked values back into typed code; this keeps the element type.
 */
export function isPortableArray(value: PortableMember): value is readonly PortableValue[] {
  return Array.isArray(value);
}

/** `isPortableRecord` for data that arrived through a structured clone. */
export function isCloneableRecord(value: CloneableValue): value is CloneableRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `isPortableArray` for data that arrived through a structured clone. */
export function isCloneableArray(value: CloneableValue): value is readonly CloneableValue[] {
  return Array.isArray(value);
}

/** `isPortableRecord` for data a rewriting pass still owns. */
export function isMutablePortableRecord(value: MutablePortableMember): value is MutablePortableRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The JSON reader lives beside these types rather than among them, because it
 * enforces the domain instead of declaring it. It is re-exported here so the
 * portable contract still has a single import for its callers.
 */
export { parsePortableJson } from './portable-json';
