import type { AgentEvent } from '@shared/types/agent';
import type { Logger } from '../logging/logger';
import type { AgentRepository } from '../db/repositories/agent-repository';
import type { AgentEnvironmentManager } from './environment-manager';
import type { AgentServiceLiveness } from './agent-service-liveness';
import type { ActiveRun } from './agent-run-registry';
import { RunEventConsumer } from './agent-run-consumer';

export type AgentRunEventsOptions = {
  readonly repository: AgentRepository;
  readonly environments: AgentEnvironmentManager;
  readonly log: Logger;
  readonly liveness: AgentServiceLiveness;
};

/**
 * Owns how run events reach durable storage and the renderer: one subscriber
 * per owning window, the per-run consumers, and the cancellation record every
 * stop path writes.
 */
export class AgentRunEvents {
  private readonly options: AgentRunEventsOptions;
  private readonly listeners = new Map<number, (event: AgentEvent) => void>();

  constructor(options: AgentRunEventsOptions) {
    this.options = options;
  }

  subscribe(ownerId: number, callback: (event: AgentEvent) => void): () => void {
    this.listeners.set(ownerId, callback);
    return () => {
      if (this.listeners.get(ownerId) === callback) this.listeners.delete(ownerId);
    };
  }

  emit(ownerId: number, event: AgentEvent): void {
    this.listeners.get(ownerId)?.(event);
  }

  unsubscribeOwner(ownerId: number): void {
    this.listeners.delete(ownerId);
  }

  clearSubscribers(): void {
    this.listeners.clear();
  }

  /** Writes the cancelled status and event without delivering it. */
  persistCancelled(sessionId: string): AgentEvent {
    this.options.repository.updateSession(sessionId, { status: 'cancelled' });
    return this.options.repository.appendEvent({ sessionId, type: 'cancelled', timestamp: new Date().toISOString() });
  }

  /** Writes the cancelled status and event, and delivers it to the owner. */
  recordCancelled(sessionId: string, ownerId: number): void {
    this.emit(ownerId, this.persistCancelled(sessionId));
  }

  consume(sessionId: string, run: ActiveRun): Promise<void> {
    const consumer = new RunEventConsumer({
      repository: this.options.repository,
      environments: this.options.environments,
      log: this.options.log,
      liveness: this.options.liveness,
      emit: (event) => { this.emit(run.ownerId, event); },
    }, sessionId, run);
    return consumer.consume();
  }
}
