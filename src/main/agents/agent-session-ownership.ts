import { InterleafError } from '@shared/errors/interleaf-error';
import type { AgentServiceLiveness } from './agent-service-liveness';

/**
 * Item C: which window may act on a session, and whether that window is gone.
 *
 * `released` is set by main alone, and only after a destroyed owner's runs have
 * been cancelled and its pending operations have drained. A released record
 * still names the window that owned the session, so a replacement window
 * performs an explicit handoff from a dead owner rather than adopting a session
 * it merely knows the ID of. A record that is not released is never replaced.
 */
type SessionOwnership = { readonly ownerId: number; released: boolean };

/**
 * A main-issued successor authority for one session (item C).
 *
 * Nothing a renderer says mints one of these. Main mints a grant when it
 * releases a destroyed owner's session, and when its own window factory adopts
 * the replacement window, always binding the exact session, the owner it is
 * taken from (`null` for a session recovered from an earlier app run), and the
 * one window authorized to receive it. A window that merely knows a session ID
 * — including another live `webContents` in this process — holds no grant and
 * is refused.
 */
export type SessionHandoffGrant = {
  readonly previousOwnerId: number | null;
  readonly successorOwnerId: number;
};

/**
 * One owner-scoped operation that is still running. Destroying the owner's
 * window, or shutting the runtime down, cancels it; its continuation proves it
 * is still live after every await.
 */
export class OwnerOperation {
  readonly ownerId: number;
  readonly done: Promise<void>;
  private readonly liveness: AgentServiceLiveness;
  private resolveDone: () => void = () => undefined;
  private cancelled = false;

  constructor(ownerId: number, liveness: AgentServiceLiveness) {
    this.ownerId = ownerId;
    this.liveness = liveness;
    this.done = new Promise<void>((resolve) => { this.resolveDone = resolve; });
  }

  assertLive(): void {
    if (this.cancelled || this.liveness.isShuttingDown()) {
      throw new InterleafError('internal', 'The pending agent operation was cancelled before execution could begin.');
    }
  }

  cancel(): void {
    this.cancelled = true;
  }

  settle(): void {
    this.resolveDone();
  }
}

/**
 * Owns which window may act on each session (item C): ownership records,
 * main-issued handoff grants, destroyed windows, and each owner's pending
 * operations.
 */
export class AgentSessionOwnership {
  private readonly liveness: AgentServiceLiveness;
  private readonly owners = new Map<string, SessionOwnership>();
  /** Main-issued successor authorities, keyed by session (item C). */
  private readonly handoffGrants = new Map<string, SessionHandoffGrant>();
  /** The `webContents` id of the window main's own factory last created. */
  private mainWindowOwnerId: number | null = null;
  /** Owners whose window has been destroyed. Recorded synchronously when the
   * destruction begins, so a suspended operation's continuation cannot act for
   * a window that was destroyed while it was awaiting. */
  private readonly destroyedOwners = new Set<number>();
  private readonly pendingOperations = new Map<number, Set<OwnerOperation>>();

  constructor(liveness: AgentServiceLiveness) {
    this.liveness = liveness;
  }

  /** Binds a newly created session to the window that started it. */
  record(sessionId: string, ownerId: number): void {
    this.owners.set(sessionId, { ownerId, released: false });
  }

  /**
   * Item C: ownership is never inferred from a renderer-supplied session ID.
   * A window acts on a session only while it holds a live ownership record,
   * which it obtains by starting the run or through a claim.
   */
  assertOwner(sessionId: string, ownerId: number): void {
    const ownership = this.owners.get(sessionId);
    if (ownership?.ownerId !== ownerId || !this.isLive(ownership)) {
      throw new InterleafError('sender-rejected', 'The agent session is not owned by this window.');
    }
  }

  /**
   * Main's own window factory declares the one main window (item C).
   *
   * This is the only source of successor authority. Adopting a window mints a
   * grant for every session whose owner main has already released, and for
   * every session recovered from an earlier app run, binding each to this
   * window alone. Grants minted for an earlier window are void: a window that
   * no longer exists cannot pass its turn on.
   */
  adoptMainWindow(ownerId: number): void {
    this.mainWindowOwnerId = ownerId;
    this.destroyedOwners.delete(ownerId);
    this.handoffGrants.clear();
    for (const [sessionId, ownership] of this.owners) {
      if (ownership.ownerId !== ownerId && !this.isLive(ownership)) {
        this.handoffGrants.set(sessionId, { previousOwnerId: ownership.ownerId, successorOwnerId: ownerId });
      }
    }
  }

  /**
   * Whether `ownerId` may take this session over, as authorized by main alone.
   *
   * Returns the grant that permits the transfer, or `'already-owned'` when the
   * caller is the live owner already. Nothing the caller supplies contributes
   * to the decision beyond naming the session: authority comes from a grant
   * main minted in `adoptMainWindow`/`beginOwnerDestruction`, or — for a
   * session no window has owned in this process, left by an earlier app run —
   * from being the window main's own factory created.
   */
  authorizeHandoff(sessionId: string, ownerId: number): SessionHandoffGrant | 'already-owned' {
    const ownership = this.owners.get(sessionId);
    if (ownership !== undefined && this.isLive(ownership)) {
      if (ownership.ownerId === ownerId) return 'already-owned';
      throw new InterleafError('sender-rejected', 'The agent session is owned by a live window.');
    }
    if (this.destroyedOwners.has(ownerId)) {
      throw new InterleafError('sender-rejected', 'This window is not authorized to take over the agent session.');
    }
    const grant = this.handoffGrants.get(sessionId);
    if (grant?.successorOwnerId === ownerId) return grant;
    if (ownership === undefined && this.mainWindowOwnerId === ownerId) {
      // Recovery binding: main adopted this window, and no window in this
      // process has ever owned the persisted session.
      return { previousOwnerId: null, successorOwnerId: ownerId };
    }
    throw new InterleafError('sender-rejected', 'This window is not authorized to take over the agent session.');
  }

  /** Spends the grant and binds the session to its new owner. */
  transfer(sessionId: string, ownerId: number): void {
    this.owners.set(sessionId, { ownerId, released: false });
    // The grant is spent; it cannot authorize a second transfer.
    this.handoffGrants.delete(sessionId);
  }

  /**
   * The synchronous first half of destroying a window, run before any await so
   * a suspended operation that resumes later sees that its window is gone.
   * Returns the owner's pending operations, now cancelled, for the caller to
   * drain.
   */
  beginOwnerDestruction(ownerId: number): readonly Promise<void>[] {
    this.destroyedOwners.add(ownerId);
    if (this.mainWindowOwnerId === ownerId) this.mainWindowOwnerId = null;
    // A grant issued to this window dies with it.
    for (const [sessionId, grant] of this.handoffGrants) {
      if (grant.successorOwnerId === ownerId) this.handoffGrants.delete(sessionId);
    }
    // If main's window already exists, its sessions pass to it now; otherwise
    // the next `adoptMainWindow` mints the grants.
    const successorOwnerId = this.mainWindowOwnerId;
    if (successorOwnerId !== null) {
      for (const [sessionId, ownership] of this.owners) {
        if (ownership.ownerId === ownerId) this.handoffGrants.set(sessionId, { previousOwnerId: ownerId, successorOwnerId });
      }
    }
    return this.cancelOperations(this.operationsOf(ownerId));
  }

  /**
   * Item C: the window is gone. Its sessions keep naming it, now marked
   * released, so a replacement window must take them through an explicit
   * handoff and a live owner's sessions stay untouchable.
   */
  releaseOwner(ownerId: number): void {
    for (const ownership of this.owners.values()) {
      if (ownership.ownerId === ownerId) ownership.released = true;
    }
  }

  beginOperation(ownerId: number): OwnerOperation {
    const operation = new OwnerOperation(ownerId, this.liveness);
    const operations = this.pendingOperations.get(ownerId) ?? new Set<OwnerOperation>();
    operations.add(operation);
    this.pendingOperations.set(ownerId, operations);
    return operation;
  }

  finishOperation(operation: OwnerOperation): void {
    const operations = this.pendingOperations.get(operation.ownerId);
    if (operations !== undefined) {
      operations.delete(operation);
      if (operations.size === 0) this.pendingOperations.delete(operation.ownerId);
    }
    operation.settle();
  }

  pendingOperationCount(): number {
    let count = 0;
    for (const operations of this.pendingOperations.values()) count += operations.size;
    return count;
  }

  /** Completion of every operation `ownerId` currently has in flight. */
  pendingCompletionsOf(ownerId: number): readonly Promise<void>[] {
    return this.operationsOf(ownerId).map((operation) => operation.done);
  }

  /** Shutdown: cancels every pending operation and returns their completions. */
  cancelAllOperations(): readonly Promise<void>[] {
    const operations = [...this.pendingOperations.values()].flatMap((entries) => [...entries]);
    return this.cancelOperations(operations);
  }

  private operationsOf(ownerId: number): readonly OwnerOperation[] {
    return [...(this.pendingOperations.get(ownerId) ?? [])];
  }

  private cancelOperations(operations: readonly OwnerOperation[]): readonly Promise<void>[] {
    for (const operation of operations) operation.cancel();
    return operations.map((operation) => operation.done);
  }

  /**
   * Ownership only counts while the window behind it still exists. `released`
   * is written after the destroyed owner's drain; `destroyedOwners` is written
   * synchronously before it. An operation that suspended before its window was
   * destroyed therefore cannot resume into a privileged action, and a claim
   * started mid-drain does not see the dying owner as live.
   */
  private isLive(ownership: SessionOwnership): boolean {
    return !ownership.released && !this.destroyedOwners.has(ownership.ownerId);
  }
}
