/**
 * The error a failing operation threw.
 *
 * A test that inspects a rejection itself — its code, its message, or the fact
 * that no secret survived in it — needs the thrown value rather than a matcher.
 * `try`/`catch` keeps the caught binding implicitly typed, and this hands it
 * back as the `Error` every failing path in the application actually throws; a
 * non-`Error` rejection is wrapped so the assertion still reads something.
 * Resolving is itself a failure: the caller asked for the error.
 */
export async function rejectionOf<T>(operation: Promise<T>): Promise<Error> {
  try {
    await operation;
  } catch (caught) {
    return caught instanceof Error ? caught : new Error(String(caught));
  }
  throw new Error('The operation was expected to fail, but it resolved.');
}

/**
 * The error a failing synchronous call threw.
 *
 * The synchronous counterpart of `rejectionOf`: returning normally is itself a
 * failure, because the caller asked for the error.
 */
export function thrownBy(operation: () => void): Error {
  try {
    operation();
  } catch (caught) {
    return caught instanceof Error ? caught : new Error(String(caught));
  }
  throw new Error('The operation was expected to throw, but it returned.');
}

/**
 * What an operation settled with: its value, or the error it failed with.
 *
 * For a test that only learns afterwards whether a race let the operation
 * through, so either outcome has to be kept for the assertion.
 */
export async function outcomeOf<T>(operation: Promise<T>): Promise<T | Error> {
  try {
    return await operation;
  } catch (caught) {
    return caught instanceof Error ? caught : new Error(String(caught));
  }
}
