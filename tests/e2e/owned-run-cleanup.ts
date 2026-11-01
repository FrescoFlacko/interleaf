/**
 * Cleanup for an E2E run that owns its app profile and working directory.
 *
 * Contract:
 * - Owned paths are removed only after the app closed, or after its process
 *   positively exited (a missing process is not proof). Otherwise every path
 *   is kept, for explicit cleanup, and nothing is killed.
 * - Each removal is attempted on its own; the outcome names exactly what was
 *   removed and what was kept.
 * - Neither cleanup nor its report throws: every close, exit-proof and removal
 *   failure is recorded with the exact value thrown.
 * - Whatever the test body threw is rethrown as that exact value. A passing body
 *   whose cleanup failed or kept anything fails with every cleanup failure.
 * - The report never stringifies an object it did not build. Errors are read
 *   defensively; a value that cannot be read is reported as undescribable.
 */

/**
 * What a test body or a cleanup step may throw: JavaScript allows any value, so
 * this is the type the catch clause infers, kept as it is rather than narrowed.
 */
async function attempt(action: () => Promise<void>) {
  try {
    await action();
    return { failed: false } as const;
  } catch (thrown) {
    return { failed: true, thrown } as const;
  }
}

export type BodyOutcome = Awaited<ReturnType<typeof attempt>>;
export type Thrown = Extract<BodyOutcome, { readonly failed: true }>['thrown'];

/** Runs the test body, recording whether it failed separately from what it threw. */
export function runBody(body: () => Promise<void>): Promise<BodyOutcome> {
  return attempt(body);
}

type CleanupFailure = {
  readonly step: 'close' | 'exit-proof' | 'remove';
  /** The owned path a removal failed on; null for close and exit proof. */
  readonly path: string | null;
  readonly thrown: Thrown;
};

export type OwnedCleanup = {
  /** closed: close resolved. exited: close failed but the process positively exited. unproven: neither. */
  readonly exit: 'closed' | 'exited' | 'unproven';
  readonly removed: readonly string[];
  readonly retained: readonly string[];
  readonly failures: readonly CleanupFailure[];
};

function exitProof(hasExited: () => boolean, failures: CleanupFailure[]): boolean {
  try {
    return hasExited();
  } catch (thrown) {
    failures.push({ step: 'exit-proof', path: null, thrown });
    return false;
  }
}

export async function closeThenRemoveOwned(options: {
  readonly close: () => Promise<void>;
  /** True only with positive evidence the app's process has exited. */
  readonly hasExited: () => boolean;
  readonly owned: readonly string[];
  readonly remove: (path: string) => void;
}): Promise<OwnedCleanup> {
  const failures: CleanupFailure[] = [];
  const closing = await attempt(options.close);
  if (closing.failed) failures.push({ step: 'close', path: null, thrown: closing.thrown });
  const exit = !closing.failed ? 'closed' : exitProof(options.hasExited, failures) ? 'exited' : 'unproven';
  if (exit === 'unproven') return { exit, removed: [], retained: [...options.owned], failures };
  const removed: string[] = [];
  const retained: string[] = [];
  for (const path of options.owned) {
    try {
      options.remove(path);
      removed.push(path);
    } catch (thrown) {
      failures.push({ step: 'remove', path, thrown });
      retained.push(path);
    }
  }
  return { exit, removed, retained, failures };
}

function describeError(error: Error): string {
  const { name, message } = error;
  return typeof name === 'string' && typeof message === 'string' ? `${name}: ${message}` : '[undescribable thrown value]';
}

function describeThrown(thrown: Thrown): string {
  try {
    switch (typeof thrown) {
      case 'undefined': return 'undefined';
      case 'string': return JSON.stringify(thrown);
      case 'number':
      case 'boolean':
      case 'bigint': return String(thrown);
      case 'symbol': return thrown.toString();
      case 'function': return '[function]';
      default:
        if (thrown === null) return 'null';
        return thrown instanceof Error ? describeError(thrown) : Object.prototype.toString.call(thrown);
    }
  } catch {
    return '[undescribable thrown value]';
  }
}

const EXIT_LABEL: Readonly<Record<OwnedCleanup['exit'], string>> = {
  closed: 'app closed',
  exited: 'app exited after close failed',
  unproven: 'app exit not proven',
};

function paths(list: readonly string[]): string {
  return list.length === 0 ? 'none' : list.join(', ');
}

function describeCleanup(cleanup: OwnedCleanup): string {
  const summary = `${EXIT_LABEL[cleanup.exit]}; removed: ${paths(cleanup.removed)}; kept: ${paths(cleanup.retained)}`;
  if (cleanup.failures.length === 0) return summary;
  const failures = cleanup.failures.map((failure) => `${failure.step}${failure.path === null ? '' : ` ${failure.path}`}: ${describeThrown(failure.thrown)}`);
  return `${summary}; failures: ${failures.join('; ')}`;
}

function settle(body: BodyOutcome, cleanup: OwnedCleanup): void {
  if (body.failed) throw body.thrown;
  if (cleanup.failures.length === 0 && cleanup.retained.length === 0) return;
  throw new AggregateError(cleanup.failures.map((failure) => failure.thrown), `Owned cleanup did not complete (${describeCleanup(cleanup)})`);
}

/** Ends the test: the body's own failure first and unchanged, otherwise any cleanup failure. */
export const settleOwnedRun = Object.assign(settle, { describe: describeCleanup });
