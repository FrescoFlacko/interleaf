/**
 * Portable typed error hierarchy shared across process boundaries.
 * Must not import Node.js or Electron modules (AGENTS.md §1 invariant 4).
 */

export const INTERLEAF_ERROR_CODES = [
  'internal',
  'validation',
  'unknown-channel',
  'sender-rejected',
  'media-forbidden',
  'media-not-found',
  'mode-resolution-failed',
  'security-violation',
] as const;
export type InterleafErrorCode = (typeof INTERLEAF_ERROR_CODES)[number];

/**
 * The wire form of an `InterleafError`. Only these three members are written or
 * read; the bounded schema in `@shared/schemas/agent` tolerates extra members
 * on a stored payload, but nothing in the app depends on one.
 */
export type SerializedInterleafError = {
  readonly __interleafError: true;
  readonly code: InterleafErrorCode;
  readonly message: string;
};

export class InterleafError extends Error {
  readonly code: InterleafErrorCode;

  /**
   * A cause is kept only when it is an error. A catch block narrows its own
   * binding and passes the error on, or normalizes what it caught with
   * `toError` from `@shared/models/caught-error`. A catch block that narrowed
   * its binding to nothing passes `null`, and no cause is carried.
   */
  constructor(code: InterleafErrorCode, message: string, options?: { readonly cause: Error | null }) {
    super(message, options?.cause == null ? undefined : { cause: options.cause });
    this.name = 'InterleafError';
    this.code = code;
  }

  toPayload(): SerializedInterleafError {
    return { __interleafError: true, code: this.code, message: this.message };
  }
}

export function interleafErrorFromPayload(payload: SerializedInterleafError): InterleafError {
  return new InterleafError(payload.code, payload.message);
}

/**
 * The payload returned for a failure that has no safe user-facing form.
 *
 * The caught value is deliberately not an argument: a user-facing payload
 * carries the diagnostic identifier only, never provider, path or credential
 * detail. Callers log the caught value under that identifier instead.
 */
export function serializeInternalError(diagnosticId: string): SerializedInterleafError {
  return new InterleafError(
    'internal',
    `The request could not be completed. Diagnostic ID: ${diagnosticId}`
  ).toPayload();
}
