/**
 * Caught values, described precisely.
 *
 * A `throw` can produce anything, so the language types a `catch` binding for
 * us and no parameter can accept one directly. That ambiguity is resolved where
 * it arises: a catch block narrows its own binding with `instanceof Error`, and
 * what leaves the block is either an `Error` or `null` — "something was thrown,
 * but not an error". Everything here works with that closed pair, so no caller
 * has to carry an open value around to reach a description, a code or a log.
 */

/** The message used for a thrown value that was not an `Error`. */
const NON_ERROR_MESSAGE = 'A non-error value was thrown.';

/** The fields diagnostics and recovery paths actually read. */
export type CaughtError = {
  /** `Error.name`, or `'unknown'` when a non-error value was thrown. */
  readonly name: string;
  /** `Error.message`, or a fixed description when a non-error value was thrown. */
  readonly message: string;
  /** The `errno`-style code when the platform supplied one, else `null`. */
  readonly code: string | null;
};

/**
 * Describes a caught error.
 *
 * Call it from the catch block that owns the binding:
 * `describeError(error instanceof Error ? error : null)`.
 */
export function describeError(caught: Error | null): CaughtError {
  if (caught === null) return { name: 'unknown', message: NON_ERROR_MESSAGE, code: null };
  return { name: caught.name, message: caught.message, code: errnoCode(caught) };
}

/**
 * The caught value as an `Error`.
 *
 * An error is returned as it is, so its type, stack and `errno` code survive; a
 * value that was not an error becomes one fixed safe error instead, since
 * nothing about it is worth carrying further.
 */
export function toError(caught: Error | null): Error {
  return caught ?? new Error(NON_ERROR_MESSAGE);
}

/** True when the platform attached this `errno` code to the caught error. */
export function errorHasCode(caught: Error | null, code: string): boolean {
  return caught !== null && errnoCode(caught) === code;
}

/** Node attaches an `errno` string to filesystem, socket and process errors. */
export function errnoCode(error: Error): string | null {
  return 'code' in error && typeof error.code === 'string' ? error.code : null;
}

/**
 * Awaits a promise nobody else is waiting on and reports a rejection.
 *
 * The promise-side counterpart of a catch block: the rejection reason is
 * narrowed here, once, and `report` receives the same closed pair every catch
 * block passes on. The returned promise settles, never rejects, so a `finally`
 * may still be chained onto it.
 */
export async function reportRejection<T>(promise: Promise<T>, report: (caught: Error | null) => void): Promise<void> {
  try {
    await promise;
  } catch (error) {
    report(error instanceof Error ? error : null);
  }
}
