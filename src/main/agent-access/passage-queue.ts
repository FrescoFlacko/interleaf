import type { AgentSource } from '@shared/schemas/agent-access';
import { InterleafError } from '@shared/errors/interleaf-error';
import { parsePassageLink, type PassageReference } from './passage-link';

/** The OS may deliver a link before the window exists; only the latest is kept. */
export class PassageQueue {
  private pending: PassageReference | AgentSource | 'invalid' | null = null;
  private notify: (() => void) | null = null;
  enqueue(values: readonly string[]): boolean {
    for (const value of values) {
      if (!value.startsWith('interleaf:')) continue;
      try { this.pending = parsePassageLink(value); } catch { this.pending = 'invalid'; }
      this.notify?.(); return true;
    }
    return false;
  }
  enqueueSource(source: AgentSource): void { this.pending = source; this.notify?.(); }
  take(): PassageReference | AgentSource | null {
    const next = this.pending; this.pending = null;
    if (next === 'invalid') throw new InterleafError('validation', 'Invalid Interleaf passage link.');
    return next;
  }
  attach(notify: () => void): void { this.notify = notify; if (this.pending) notify(); }
}
