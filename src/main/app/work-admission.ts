import { InterleafError } from '@shared/errors/interleaf-error';

/**
 * Counts one service's in-flight work and refuses new work once closed.
 *
 * An update restart closes admission synchronously, before the renderer close
 * handshake, so nothing can start in the window between the final idle probe
 * and the drain. Work already admitted keeps running and stays counted until
 * it settles.
 */
export class WorkAdmission {
  private live = 0;
  private closed = false;

  /** Admits `work` synchronously, or rejects without running it once admission has closed. */
  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new InterleafError('internal', 'Application is shutting down.'));
    this.live += 1;
    let pending: Promise<T>;
    try {
      pending = work();
    } catch (error) {
      pending = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return pending.finally(() => { this.live -= 1; });
  }

  liveWork(): number {
    return this.live;
  }

  close(): void {
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }
}
