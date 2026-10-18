/**
 * The clock and cancellation one media phase runs under.
 *
 * The image half of an import needs a signal of its own rather than the
 * import's: the caller's cancellation must still end everything, but running
 * out of time to download the eleventh figure must abort only what this phase
 * started. The page fetch and its address checks finished before the phase
 * began, and a media deadline reaching back into them would weaken the very
 * checks that decided the article was safe to fetch.
 *
 * Expiry is asked for directly rather than inferred from the signal, so a phase
 * that begins with no time left starts nothing at all instead of waiting for a
 * timer callback that can only run after the first requests are already out.
 */
export type MediaPhaseClock = {
  /** Aborted by the caller's cancellation or by this phase's deadline. */
  readonly signal: AbortSignal;
  /** True once the deadline has passed. */
  expired(): boolean;
  /** Releases the timer and the caller subscription. */
  dispose(): void;
};

/** Starts a phase clock; `dispose` must run once the phase joins. */
export function startMediaPhaseClock(
  caller: AbortSignal | undefined,
  deadline: number | undefined
): MediaPhaseClock {
  const controller = new AbortController();
  const onCallerAbort = (): void => {
    controller.abort();
  };
  caller?.addEventListener('abort', onCallerAbort, { once: true });
  const expiry =
    deadline === undefined
      ? undefined
      : setTimeout(
          () => {
            controller.abort();
          },
          Math.max(0, deadline - Date.now())
        );
  // A pending phase timer must never hold the process open on its own.
  expiry?.unref();

  return {
    signal: controller.signal,
    expired: () => deadline !== undefined && Date.now() >= deadline,
    dispose: () => {
      clearTimeout(expiry);
      caller?.removeEventListener('abort', onCallerAbort);
    },
  };
}
