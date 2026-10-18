import type { AgentEvent, AgentEventDraft } from '@shared/types/agent';
import type { EnvironmentTestResult } from '@shared/types/agent-environment';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { Logger } from '../logging/logger';
import type { AgentRepository } from '../db/repositories/agent-repository';
import { EventRedactor } from './event-redaction';
import type { AgentEnvironmentManager } from './environment-manager';
import type { AgentServiceLiveness } from './agent-service-liveness';
import type { ActiveRun, TerminalRunStatus } from './agent-run-registry';
import { extractProviderSessionId, sanitizeChangedFilesData, testResultFromEventData } from './agent-event-data';

export type RunEventConsumerDeps = {
  readonly repository: AgentRepository;
  readonly environments: AgentEnvironmentManager;
  readonly log: Logger;
  readonly liveness: AgentServiceLiveness;
  /** Delivers a persisted event to the run owner's renderer subscription. */
  readonly emit: (event: AgentEvent) => void;
};

/** Item I: whether a draft is a test result, and whether it was admitted. */
type TestAdmission =
  | { readonly kind: 'not-a-test' }
  | { readonly kind: 'refused' }
  | { readonly kind: 'admitted'; readonly result: EnvironmentTestResult };

function resolveTerminalStatus(status: TerminalRunStatus | null, cancelRequested: boolean): TerminalRunStatus {
  if (status !== null) return status;
  return cancelRequested ? 'cancelled' : 'failed';
}

function shouldRecordMissingTerminal(status: TerminalRunStatus | null, failureRecorded: boolean): boolean {
  return status === null && !failureRecorded;
}

function exitCodeForTerminalStatus(status: TerminalRunStatus | null): number | null {
  if (status === 'completed') return 0;
  if (status === 'failed') return 1;
  return null;
}

/** Stamps an adapter event with its session and bounds what it may carry. */
function toBoundedDraft(sessionId: string, incoming: AgentEvent): AgentEventDraft {
  const timestamp = incoming.timestamp || new Date().toISOString();
  if (incoming.type === 'error') {
    return { sessionId, type: 'error', timestamp, text: incoming.text ?? incoming.error.message.slice(0, 2_000), error: incoming.error };
  }
  if (incoming.type === 'changed-files') {
    return { ...incoming, sessionId, timestamp, data: sanitizeChangedFilesData(incoming.data) };
  }
  return { ...incoming, sessionId, timestamp };
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Consumes one active run's events: redaction, persistence, renderer push,
 * test-result admission, and the terminal state written once the adapter's
 * completion settles.
 */
export class RunEventConsumer {
  private readonly deps: RunEventConsumerDeps;
  private readonly sessionId: string;
  private readonly run: ActiveRun;
  // There is no production secret source on this path: environment delivery
  // never implies secrecy and no caller registers run secrets here. The
  // persistence redactor therefore runs with an empty explicit value set and
  // relies on the always-on credential-shape detectors.
  private readonly redactor = new EventRedactor([]);
  private finalReport: string | null = null;
  private terminalStatus: TerminalRunStatus | null = null;
  private failureRecorded = false;
  private endedEventCount = 0;

  constructor(deps: RunEventConsumerDeps, sessionId: string, run: ActiveRun) {
    this.deps = deps;
    this.sessionId = sessionId;
    this.run = run;
  }

  async consume(): Promise<void> {
    // Item I: every run opens its own admission window, so a resumed session
    // is bounded again instead of inheriting an exhausted budget.
    this.deps.environments.beginTestRun(this.sessionId);
    try {
      await this.readEvents();
    } catch (error) {
      // A read failure surfaces after the run is settled, unless persistence
      // closed during settlement: then the late continuation stops quietly.
      if (await this.settle()) throw error;
      return;
    }
    await this.settle();
  }

  private isPersistenceClosed(): boolean {
    return this.deps.liveness.isPersistenceClosed();
  }

  private async readEvents(): Promise<void> {
    try {
      for await (const incoming of this.run.adapterRun.events) {
        if (this.isPersistenceClosed()) continue;
        await this.persistBatch(this.redactor.push(toBoundedDraft(this.sessionId, incoming)));
      }
      await this.persistBatch(this.redactor.finish());
    } catch (error) {
      if (this.isPersistenceClosed()) return;
      this.deps.log.error('agent run failed', { sessionId: this.sessionId, errorType: error instanceof Error ? error.name : typeof error });
      await this.persistBatch(this.redactor.finish());
      this.failureRecorded = true;
    }
  }

  private async persistBatch(batch: readonly AgentEventDraft[]): Promise<void> {
    for (const draft of batch) {
      if (this.isPersistenceClosed()) return;
      await this.persistEvent(draft);
    }
  }

  private async persistEvent(draft: AgentEventDraft): Promise<void> {
    // Item I: admission is decided before the result is persisted, delivered,
    // turned into an artifact, or allowed to rebuild the review. Deciding
    // afterwards left a flood amplifying every refused frame into database
    // rows, subscriber traffic, and a full metadata fsync.
    const admission = this.admitTestResult(draft);
    // A refused result is accounted for in this run's one coalesced summary,
    // which is written once when the run ends.
    if (admission.kind === 'refused') return;
    const event = this.deps.repository.appendEvent(draft);
    this.recordEventRows(event);
    if (admission.kind === 'admitted' && !(await this.persistTestResult(admission.result))) return;
    this.trackTerminalSignals(event);
    this.deps.emit(event);
  }

  private admitTestResult(draft: AgentEventDraft): TestAdmission {
    if (draft.type !== 'tests') return { kind: 'not-a-test' };
    const candidate = testResultFromEventData(draft.data);
    if (!this.deps.environments.admitTestResult(this.sessionId, candidate).accepted) return { kind: 'refused' };
    return { kind: 'admitted', result: candidate };
  }

  private recordEventRows(event: AgentEvent): void {
    const { repository } = this.deps;
    if ('data' in event) {
      const providerId = extractProviderSessionId(event.data);
      if (providerId !== null) repository.updateSession(this.sessionId, { providerSessionId: providerId });
    }
    if (event.type === 'changed-files') {
      repository.addArtifact({ sessionId: this.sessionId, kind: 'changed_files', metadata: event.data });
    }
  }

  /** Returns false when persistence closed while the inventory was flushed. */
  private async persistTestResult(result: EnvironmentTestResult): Promise<boolean> {
    const { environments, repository } = this.deps;
    await environments.flushTestInventory(this.sessionId);
    if (this.isPersistenceClosed()) return false;
    repository.addArtifact({ sessionId: this.sessionId, kind: 'test_result', metadata: result });
    const review = await environments.getReview(this.sessionId);
    if (this.isPersistenceClosed()) return false;
    if (review !== null) repository.updateSession(this.sessionId, { environment: { ...review, sessionId: this.sessionId } });
    return true;
  }

  private trackTerminalSignals(event: AgentEvent): void {
    if (event.type === 'final') this.finalReport = event.text;
    if (event.type === 'error') this.recordFailureSignal();
    if (event.type === 'ended') {
      this.recordEnded(event.exitCode);
    } else if (event.type === 'cancelled') {
      this.run.markCancelRequested();
      this.recordPendingTerminal('cancelled');
    }
  }

  /**
   * A typed process diagnostic is already a terminal failure signal for the
   * persisted session, even when process-group reaping is still pending. The
   * active run stays registered so environment mutations remain blocked until
   * completion resolves.
   */
  private recordFailureSignal(): void {
    this.failureRecorded = true;
    this.recordPendingTerminal('failed');
  }

  private recordEnded(exitCode: number | null): void {
    this.endedEventCount += 1;
    this.recordPendingTerminal(this.endedStatus(exitCode));
  }

  private endedStatus(exitCode: number | null): TerminalRunStatus {
    if (this.run.cancelRequested) return 'cancelled';
    if (this.failureRecorded) return 'failed';
    return exitCode === 0 ? 'completed' : 'failed';
  }

  private recordPendingTerminal(status: TerminalRunStatus): void {
    this.terminalStatus = status;
    this.run.recordPendingTerminal(status);
  }

  /**
   * Runs once the event stream ends. Returns false when it stopped early
   * because persistence closed, leaving the run for shutdown to clear.
   */
  private async settle(): Promise<boolean> {
    if (!(await this.awaitCompletion())) return false;
    if (this.isPersistenceClosed()) return false;
    this.recordSyntheticEnded();
    this.recordMissingTerminal();
    await this.persistSuppressedTestSummary();
    if (!(await this.persistFinalReview())) return false;
    if (this.run.markTerminal()) {
      this.deps.repository.updateSession(this.sessionId, {
        status: resolveTerminalStatus(this.terminalStatus, this.run.cancelRequested),
        finalReport: this.finalReport,
      });
    }
    this.run.retire();
    return true;
  }

  /** Returns false when the completion failed after persistence closed. */
  private async awaitCompletion(): Promise<boolean> {
    try {
      await this.run.adapterRun.completion;
      return true;
    } catch (error) {
      this.deps.log.error('agent completion failed', { sessionId: this.sessionId, errorType: error instanceof Error ? error.name : typeof error });
      if (this.isPersistenceClosed()) return false;
      this.recordCompletionFailure();
      return true;
    }
  }

  private recordCompletionFailure(): void {
    const { repository } = this.deps;
    this.failureRecorded = true;
    const error = new InterleafError('internal', 'Agent completion failed unexpectedly.').toPayload();
    this.deps.emit(repository.appendEvent({ sessionId: this.sessionId, type: 'error', error, timestamp: now() }));
    const status = this.run.cancelRequested ? 'cancelled' : 'failed';
    this.terminalStatus = status;
    if (this.run.markTerminal()) repository.updateSession(this.sessionId, { status, finalReport: this.finalReport });
  }

  /** A stream that ended without an `ended` event still gets exactly one. */
  private recordSyntheticEnded(): void {
    if (this.endedEventCount > 0) return;
    const status = this.terminalStatus ?? this.inferredTerminalStatus();
    const syntheticEnded = this.deps.repository.appendEvent({
      sessionId: this.sessionId,
      type: 'ended',
      exitCode: exitCodeForTerminalStatus(status),
      signal: null,
      timestamp: now(),
    });
    this.endedEventCount = 1;
    this.terminalStatus = status;
    this.deps.emit(syntheticEnded);
  }

  private inferredTerminalStatus(): TerminalRunStatus | null {
    if (this.run.cancelRequested) return 'cancelled';
    return this.failureRecorded ? 'failed' : null;
  }

  private recordMissingTerminal(): void {
    if (!shouldRecordMissingTerminal(this.terminalStatus, this.failureRecorded)) return;
    const { repository } = this.deps;
    if (this.run.cancelRequested) {
      this.run.markTerminal();
      repository.updateSession(this.sessionId, { status: 'cancelled', finalReport: this.finalReport });
      return;
    }
    this.failureRecorded = true;
    const error = new InterleafError('internal', 'Agent process ended without a terminal event.').toPayload();
    const event = repository.appendEvent({ sessionId: this.sessionId, type: 'error', error, timestamp: now() });
    if (this.run.markTerminal()) repository.updateSession(this.sessionId, { status: 'failed', finalReport: this.finalReport });
    this.deps.emit(event);
  }

  /**
   * Item I: the run's refused results are written once, here, as one bounded
   * coalesced frame — never one fsync and one subscriber message per refused
   * result. Terminal status and the final/ended ordering are already settled;
   * this is the run's accounting.
   */
  private async persistSuppressedTestSummary(): Promise<void> {
    const { environments, repository } = this.deps;
    try {
      const suppressed = environments.suppressedTestSummary(this.sessionId);
      await environments.flushTestInventory(this.sessionId);
      if (suppressed === null || this.isPersistenceClosed()) return;
      repository.addArtifact({ sessionId: this.sessionId, kind: 'test_result', metadata: suppressed.summary });
      const summaryEvent = repository.appendEvent({
        sessionId: this.sessionId,
        type: 'tests',
        data: { status: suppressed.summary.status, message: suppressed.summary.summary, suppressed: suppressed.suppressed },
        timestamp: now(),
      });
      this.deps.emit(summaryEvent);
    } catch (error) {
      this.deps.log.error('agent suppressed test summary persistence failed', { sessionId: this.sessionId, errorType: error instanceof Error ? error.name : typeof error });
    }
  }

  /** Returns false when persistence closed while the review was read. */
  private async persistFinalReview(): Promise<boolean> {
    try {
      const review = await this.deps.environments.getReview(this.sessionId);
      if (this.isPersistenceClosed()) return false;
      if (review !== null) this.deps.repository.updateSession(this.sessionId, { environment: { ...review, sessionId: this.sessionId } });
    } catch (error) {
      this.deps.log.error('agent environment review persistence failed', { sessionId: this.sessionId, errorType: error instanceof Error ? error.name : typeof error });
    }
    return true;
  }
}
