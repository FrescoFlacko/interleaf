import { unlink } from 'node:fs/promises';
import type { AgentSession } from '@shared/types/agent';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { Logger } from '../logging/logger';
import type { AgentRepository } from '../db/repositories/agent-repository';
import type { AgentEnvironmentManager } from './environment-manager';
import type { AgentServiceLiveness } from './agent-service-liveness';
import type { AgentRunRegistry } from './agent-run-registry';
import type { AgentRunEvents } from './agent-run-events';

export type AgentStartupRollbackOptions = {
  readonly repository: AgentRepository;
  readonly environments: AgentEnvironmentManager;
  readonly runs: AgentRunRegistry;
  readonly events: AgentRunEvents;
  readonly liveness: AgentServiceLiveness;
  readonly log: Logger;
};

/**
 * Undoes a fresh start that was cancelled or failed before its adapter run
 * became active: the prepared environment, the context packet, and the
 * session's terminal record.
 */
export class AgentStartupRollback {
  private readonly options: AgentStartupRollbackOptions;

  constructor(options: AgentStartupRollbackOptions) {
    this.options = options;
  }

  /**
   * Cancellation is observed between startup steps rather than inside them,
   * so every step ends with the same question: did the owner cancel while we
   * waited? The stored session is returned when it did, and `null` when the
   * start may continue.
   */
  async settleIfCancelled(session: AgentSession, contextPath: string | null, ownerId: number): Promise<AgentSession | null> {
    if (!this.options.runs.isClaimCancelled(session.id)) return null;
    await this.cancel(session.id, contextPath, ownerId);
    this.options.runs.releaseClaim(session.id);
    return this.options.repository.getSession(session.id) ?? session;
  }

  async cancel(sessionId: string, contextPath: string | null, ownerId: number): Promise<void> {
    const { events, log, repository } = this.options;
    if (contextPath !== null) await unlink(contextPath).catch(() => undefined);
    if (!(await this.discardEnvironment(sessionId))) return;
    try { repository.deleteContextArtifacts(sessionId); } catch { /* terminal cleanup */ }
    try {
      events.recordCancelled(sessionId, ownerId);
    } catch (error) {
      log.error('agent cancel persistence failed', { sessionId, errorType: error instanceof Error ? error.name : typeof error });
    }
  }

  async fail(sessionId: string, cause: Error | null): Promise<void> {
    const { log, repository } = this.options;
    if (!(await this.discardEnvironment(sessionId))) return;
    // The context file and its internal artifact row form one short-lived
    // resource. Remove the row as part of every startup rollback so a failed
    // write/update cannot leave a renderer-visible stale artifact reference.
    try { repository.deleteContextArtifacts(sessionId); } catch { /* terminal failure persistence below remains authoritative */ }
    try {
      const errorPayload = cause instanceof InterleafError && cause.code !== 'internal'
        ? cause.toPayload()
        : new InterleafError('internal', 'Agent startup failed.').toPayload();
      repository.appendEvent({ sessionId, type: 'error', error: errorPayload, timestamp: new Date().toISOString() });
      repository.updateSession(sessionId, { status: 'failed' });
    } catch (error) {
      log.error('agent startup persistence failed', { sessionId, errorType: error instanceof Error ? error.name : typeof error });
    }
  }

  /**
   * Discards the prepared environment, recording the discard when it worked.
   *
   * Returns false once persistence has closed: the late continuation may
   * finish external and app-owned cleanup, but must not write, delete, or emit
   * through the repository, which a timed-out shutdown may already have
   * closed. When cleanup failed the persisted environment reference is kept,
   * because it is the only bounded handle from which startup recovery can
   * retry an external Git registration or app-owned session path.
   */
  private async discardEnvironment(sessionId: string): Promise<boolean> {
    let discarded = false;
    try {
      await this.options.environments.discard(sessionId);
      discarded = true;
    } catch (error) {
      this.options.log.error('agent startup environment cleanup deferred', { sessionId, errorType: error instanceof Error ? error.name : typeof error });
    }
    if (this.options.liveness.isPersistenceClosed()) return false;
    if (discarded) this.options.repository.updateSession(sessionId, { environment: null, environmentWorkspacePath: null, environmentState: 'discarded' });
    return true;
  }
}
