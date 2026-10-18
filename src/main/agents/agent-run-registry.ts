import { describeError, reportRejection } from '@shared/models/caught-error';
import type { AgentSessionStatus } from '@shared/types/agent';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { Logger } from '../logging/logger';
import type { AgentAdapterRun } from './agent-adapter';

export type TerminalRunStatus = 'completed' | 'failed' | 'cancelled';

export function isTerminalSessionStatus(status: AgentSessionStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted';
}

/**
 * A run with a live adapter handle, from activation until its consumer has
 * persisted the terminal state and retired it.
 */
export class ActiveRun {
  readonly ownerId: number;
  readonly adapterRun: AgentAdapterRun;
  private readonly onRetire: () => void;
  private cancelRequestedFlag = false;
  private terminalFlag = false;
  private pendingTerminal: TerminalRunStatus | null = null;

  constructor(ownerId: number, adapterRun: AgentAdapterRun, onRetire: () => void) {
    this.ownerId = ownerId;
    this.adapterRun = adapterRun;
    this.onRetire = onRetire;
  }

  get cancelRequested(): boolean {
    return this.cancelRequestedFlag;
  }

  get terminal(): boolean {
    return this.terminalFlag;
  }

  /** Whether a stop request can still change this run's outcome. */
  isStoppable(): boolean {
    return !this.terminalFlag && !this.cancelRequestedFlag && this.pendingTerminal === null;
  }

  /** A stop from the owner: cancels the adapter and records the request. */
  requestStop(): void {
    this.cancelRequestedFlag = true;
    this.adapterRun.cancel();
  }

  /** The adapter reported cancellation itself. */
  markCancelRequested(): void {
    this.cancelRequestedFlag = true;
  }

  /** An event has already decided the result that will be persisted. */
  recordPendingTerminal(status: TerminalRunStatus): void {
    this.pendingTerminal = status;
  }

  /** Marks the terminal row as written. Returns false when it already was. */
  markTerminal(): boolean {
    if (this.terminalFlag) return false;
    this.terminalFlag = true;
    return true;
  }

  /**
   * Shutdown cancels a run whose result is still open. A run whose terminal
   * result an event has already decided is left to finish its persistence, so
   * a successful run is never downgraded to cancellation. Returns whether the
   * run was cancelled.
   */
  cancelForShutdown(): boolean {
    if (this.terminalFlag || this.pendingTerminal !== null) return false;
    this.requestStop();
    this.terminalFlag = true;
    return true;
  }

  /** Called once by the consumer after the terminal state is persisted. */
  retire(): void {
    this.onRetire();
  }
}

/**
 * A run that has been claimed but has not yet produced a live adapter handle.
 *
 * `kind` distinguishes the two cases a stop request must treat differently. A
 * fresh start has already persisted a new session, so cancelling it before the
 * spawn is a real cancellation of that session. A resume has not persisted
 * anything: the session it refers to still carries a prior terminal status and
 * final report, so cancelling before a live handle exists must only raise the
 * in-memory flag and leave that record untouched.
 */
export class StartingRun {
  readonly ownerId: number;
  readonly kind: 'start' | 'resume';
  private cancelRequestedFlag = false;
  private adapterRun: AgentAdapterRun | null = null;

  constructor(ownerId: number, kind: 'start' | 'resume') {
    this.ownerId = ownerId;
    this.kind = kind;
  }

  get cancelRequested(): boolean {
    return this.cancelRequestedFlag;
  }

  attach(adapterRun: AgentAdapterRun): void {
    this.adapterRun = adapterRun;
  }

  /** Raises the flag the start or resume re-reads, and cancels any handle. */
  cancel(): void {
    this.cancelRequestedFlag = true;
    this.adapterRun?.cancel();
  }

  /**
   * Whether a stop must record cancellation on the session. A resume without
   * a live handle has persisted nothing, so it records nothing: writing
   * `cancelled` would destroy the prior attempt's terminal status and final
   * report and append an event for a run that never happened.
   */
  stopRecordsCancellation(): boolean {
    return this.adapterRun !== null || this.kind === 'start';
  }
}

type EnvironmentAction = 'apply' | 'discard' | 'export-patch' | 'open-folder';
type LifecycleReservationKind = 'resume' | EnvironmentAction;

export type LifecycleReservation = {
  readonly kind: LifecycleReservationKind;
  readonly token: symbol;
  readonly done: Promise<void>;
  readonly resolveDone: () => void;
  released: boolean;
};

/** What a stop request found, and whether it must record cancellation. */
export type StopOutcome = 'record-cancellation' | 'already-settled' | 'not-running';

export type AgentRunRegistryOptions = {
  readonly log: Logger;
  /** Starts the event consumer for a newly activated run. */
  readonly consume: (sessionId: string, run: ActiveRun) => Promise<void>;
};

/**
 * Owns the in-memory lifecycle of every run: claimed starts and resumes,
 * active adapter handles, their consumers, run generations, and the lifecycle
 * reservations that serialize resume against environment actions.
 */
export class AgentRunRegistry {
  private readonly options: AgentRunRegistryOptions;
  private readonly active = new Map<string, ActiveRun>();
  private readonly starting = new Map<string, StartingRun>();
  /** Item D: a per-session counter of run generations, incremented when a run
   * is claimed (start or resume) and again when its terminal state has been
   * persisted. Copy reads it on both sides of its only suspension point, so a
   * report can only reach the clipboard if the session stood still while it
   * was being read. */
  private readonly generations = new Map<string, number>();
  private readonly consumers = new Map<string, Promise<void>>();
  /** One synchronous reservation spans resume and every filesystem lifecycle
   * action. This prevents a deferred confirmation or filesystem mutation from
   * racing an otherwise-eligible operation on the same environment. */
  private readonly reservations = new Map<string, LifecycleReservation>();

  constructor(options: AgentRunRegistryOptions) {
    this.options = options;
  }

  /** Claims a start or resume and opens a new run generation. */
  claim(sessionId: string, ownerId: number, kind: 'start' | 'resume'): StartingRun {
    const startingRun = new StartingRun(ownerId, kind);
    this.starting.set(sessionId, startingRun);
    this.advanceGeneration(sessionId);
    return startingRun;
  }

  /**
   * Read through the map rather than a held claim: a stop sets the flag while
   * the start or resume is awaiting, and shutdown drops the claim entirely.
   */
  isClaimCancelled(sessionId: string): boolean {
    return this.starting.get(sessionId)?.cancelRequested === true;
  }

  releaseClaim(sessionId: string): void {
    this.starting.delete(sessionId);
  }

  /** Promotes a claim to an active run and starts its consumer. */
  activate(sessionId: string, ownerId: number, adapterRun: AgentAdapterRun): void {
    const active = new ActiveRun(ownerId, adapterRun, () => {
      this.advanceGeneration(sessionId);
      this.active.delete(sessionId);
    });
    this.active.set(sessionId, active);
    this.starting.delete(sessionId);
    const consumer = this.options.consume(sessionId, active);
    this.consumers.set(sessionId, consumer);
    // `.finally` forwards a rejection, so this cleanup chain needs a handler of
    // its own: without one, a consumer that throws — a persistence write once
    // the database has gone away, for instance — becomes an unhandled rejection
    // in main. Shutdown still awaits and reports the consumer promise kept in
    // `this.consumers`; this only makes sure the failure is logged rather than
    // crashing the process when nothing is draining it.
    void reportRejection(consumer.finally(() => { this.consumers.delete(sessionId); }), (caught) => {
      this.options.log.error('agent consumer failed', { sessionId, errorType: describeError(caught).name });
    });
  }

  isActive(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /** Whether the session has a claimed or live run. */
  isBusy(sessionId: string): boolean {
    return this.active.has(sessionId) || this.starting.has(sessionId);
  }

  /** Sessions with a claim, an unreaped run, its consumer or a lifecycle reservation. */
  liveSessionCount(): number {
    return new Set([...this.starting.keys(), ...this.active.keys(), ...this.consumers.keys(), ...this.reservations.keys()]).size;
  }

  generation(sessionId: string): number {
    return this.generations.get(sessionId) ?? 0;
  }

  /**
   * Applies a stop to the session's live or claimed run. The caller records
   * cancellation when told to, and consults the persisted session when no run
   * is held here.
   */
  requestStop(sessionId: string, ownerId: number): StopOutcome {
    const active = this.active.get(sessionId);
    if (active !== undefined) {
      assertRunOwner(active.ownerId, ownerId);
      if (!active.isStoppable()) return 'already-settled';
      active.requestStop();
      return 'record-cancellation';
    }
    const startingRun = this.starting.get(sessionId);
    if (startingRun === undefined) return 'not-running';
    assertRunOwner(startingRun.ownerId, ownerId);
    if (startingRun.cancelRequested) return 'already-settled';
    startingRun.cancel();
    return startingRun.stopRecordsCancellation() ? 'record-cancellation' : 'already-settled';
  }

  /** Cancels every claimed run of a destroyed owner. */
  cancelClaimsOf(ownerId: number): void {
    for (const startingRun of this.starting.values()) {
      if (startingRun.ownerId === ownerId && !startingRun.cancelRequested) startingRun.cancel();
    }
  }

  /**
   * The owner's sessions with a non-terminal active run, read lazily from the
   * live map so a run that retires while the caller awaits is skipped.
   */
  *activeSessionsOf(ownerId: number): Generator<string> {
    for (const [sessionId, active] of this.active) {
      if (active.ownerId === ownerId && !active.terminal) yield sessionId;
    }
  }

  /** What a handoff must wait for before the session changes hands. */
  handoffDrains(sessionId: string): readonly Promise<void>[] {
    return [
      this.consumers.get(sessionId) ?? Promise.resolve(),
      this.reservations.get(sessionId)?.done ?? Promise.resolve(),
    ];
  }

  reserveLifecycle(sessionId: string, kind: LifecycleReservationKind): LifecycleReservation {
    const existing = this.reservations.get(sessionId);
    if (existing !== undefined) {
      throw new InterleafError('validation', `Lifecycle action "${existing.kind}" is already in progress for this session.`);
    }
    const token = Symbol(kind);
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const reservation: LifecycleReservation = { kind, token, done, resolveDone, released: false };
    this.reservations.set(sessionId, reservation);
    return reservation;
  }

  releaseLifecycle(sessionId: string, reservation: LifecycleReservation): void {
    if (reservation.released) return;
    reservation.released = true;
    if (this.reservations.get(sessionId)?.token === reservation.token) this.reservations.delete(sessionId);
    reservation.resolveDone();
  }

  /**
   * Shutdown: cancels every claim and every open active run, letting
   * `recordCancelled` persist each cancellation. Returns what shutdown must
   * wait for: each run's completion and consumer, and every reservation.
   */
  shutdownRuns(recordCancelled: (sessionId: string) => void): Promise<void>[] {
    for (const startingRun of this.starting.values()) startingRun.cancel();
    this.starting.clear();
    const activeRuns = [...this.active.entries()];
    for (const [sessionId, active] of activeRuns) {
      if (active.cancelForShutdown()) recordCancelled(sessionId);
    }
    const runWaits = activeRuns.flatMap(([sessionId, active]) => [
      reportRejection(active.adapterRun.completion, (caught) => {
        this.options.log.error('agent completion failed during shutdown', { sessionId, errorType: describeError(caught).name });
      }),
      reportRejection(this.consumers.get(sessionId) ?? Promise.resolve(), (caught) => {
        this.options.log.error('agent consumer failed during shutdown', { sessionId, errorType: describeError(caught).name });
      }),
    ]);
    return runWaits.concat([...this.reservations.values()].map((reservation) => reservation.done));
  }

  clearActive(): void {
    this.active.clear();
  }

  /** One step of the per-session generation counter (item D). */
  private advanceGeneration(sessionId: string): void {
    this.generations.set(sessionId, this.generation(sessionId) + 1);
  }
}

function assertRunOwner(runOwnerId: number, ownerId: number): void {
  if (runOwnerId !== ownerId) throw new InterleafError('sender-rejected', 'The agent session is not owned by this window.');
}
