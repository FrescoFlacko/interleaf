/**
 * The cancellation scope shutdown signals (docs/REMAINING_WORK.md item R).
 *
 * A capability probe is a short bounded child process, but shutdown must not
 * have to wait out that bound for an answer nobody will use. This owns both
 * sides of a probe — the child and the caller awaiting it — so closing can
 * cancel every child and then resolve only once each awaiting caller has been
 * answered and each child has been reaped.
 */

/** The part of a run handle the scope owns. */
export type CancellableRun = { cancel(): void; readonly completion: Promise<void> };

export class ProbeCancellationScope {
  private readonly runs = new Set<CancellableRun>();
  /** Each tracked attempt, reduced to its settlement. */
  private readonly attempts = new Set<Promise<void>>();
  private closed = false;

  /** Take ownership of a freshly spawned child. A run that lost the race with
   * `close()` is cancelled at once rather than outliving a decided drain. */
  adopt<T extends CancellableRun>(run: T): T {
    this.runs.add(run);
    if (this.closed) run.cancel();
    return run;
  }

  /** Release a child that has already settled. */
  release(run: CancellableRun): void {
    this.runs.delete(run);
  }

  /** Keep an in-progress verification in scope, so `close()` resolves only
   * once its awaiting caller has been answered. */
  track<T>(attempt: Promise<T>): Promise<T> {
    const settled = attempt.then(() => undefined, () => undefined);
    this.attempts.add(settled);
    void settled.finally(() => { this.attempts.delete(settled); });
    return attempt;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const run of this.runs) run.cancel();
    await Promise.allSettled([...this.attempts, ...[...this.runs].map((run) => run.completion)]);
  }
}
