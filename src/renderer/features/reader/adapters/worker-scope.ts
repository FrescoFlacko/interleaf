/**
 * The dedicated-worker global, as a worker entry in this program can name it.
 *
 * Worker entries are compiled in the renderer program, whose lib is the DOM, so
 * `globalThis` is typed there as a `Window` even though a worker entry really
 * runs in a `DedicatedWorkerGlobalScope`. The two members those entries use are
 * therefore declared here, shaped so the real global satisfies them: a worker
 * reads its input through `onmessage` and answers with `postMessage`, whose
 * second argument is the transfer list in a worker and the options bag on a
 * window.
 */
export type DedicatedWorkerScope<TRequest, TResponse> = {
  onmessage: ((event: MessageEvent<TRequest>) => void) | null;
  postMessage(message: TResponse, transfer?: Transferable[] | WindowPostMessageOptions): void;
};
