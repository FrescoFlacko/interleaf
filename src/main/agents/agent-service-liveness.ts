import { InterleafError } from '@shared/errors/interleaf-error';

/**
 * The agent runtime's two shutdown facts, shared by every owner.
 *
 * `shuttingDown` is set once, when shutdown begins: no new privileged work may
 * start after it. `persistenceClosed` is set only when shutdown's drain timed
 * out, because the database may already be closed: a late continuation may
 * still finish external cleanup but must not write through the repository.
 */
export class AgentServiceLiveness {
  private shuttingDown = false;
  private persistenceClosed = false;
  /** Cleared by shutdown and by an update restart's admission close. */
  private acceptingRuns = true;

  /** Marks shutdown as started. Returns false when it had already started. */
  beginShutdown(): boolean {
    if (this.shuttingDown) return false;
    this.shuttingDown = true;
    this.acceptingRuns = false;
    return true;
  }

  /**
   * An update restart refuses new runs and lifecycle actions before its
   * renderer handshake, while admitted work keeps running until drain.
   */
  closeAdmission(): void {
    this.acceptingRuns = false;
  }

  closePersistence(): void {
    this.persistenceClosed = true;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  isPersistenceClosed(): boolean {
    return this.persistenceClosed;
  }

  /** Whether the runtime has stopped, for either reason. */
  isStopped(): boolean {
    return this.shuttingDown || this.persistenceClosed;
  }

  assertLive(): void {
    if (this.isStopped()) throw new InterleafError('internal', 'Agent runtime is shutting down.');
  }

  /** The entry check of start and resume, which predates persistence closure. */
  assertAcceptingRuns(): void {
    if (!this.acceptingRuns) throw new InterleafError('internal', 'Agent runtime is shutting down.');
  }

  assertPersistenceWritable(): void {
    if (this.persistenceClosed) throw new InterleafError('internal', 'Agent persistence is no longer writable.');
  }
}
