import type { ChatSessionTitleChangedEvent } from '@shared/types/ai';
import { bridge } from '../app/api-client';
import { chatDocumentId, type ChatRuntime } from './chat-runtime';

/** The latest summary-refresh number per conversation; newest wins. */
export class SessionSummaryRefresh {
  readonly #sequences = new Map<string, number>();

  next(sessionId: string): number {
    const sequence = (this.#sequences.get(sessionId) ?? 0) + 1;
    this.#sequences.set(sessionId, sequence);
    return sequence;
  }

  isCurrent(sessionId: string, sequence: number): boolean {
    return this.#sequences.get(sessionId) === sequence;
  }
}

/** A title re-read's own sequence key, so it never supersedes a summary refresh. */
export function titleRefreshKey(sessionId: string): string {
  return `title:${sessionId}`;
}

/**
 * Applies a title main renamed automatically, by re-reading it.
 *
 * The event names a session only; the title itself comes from the
 * document-scoped lookup, so a forged or stale event can at most cause a
 * re-read. It is handled whatever the turn state is — the answer's `done` has
 * usually cleared the stream by now — but only for a conversation of the open
 * document that is still listed, so a deleted one is never resurrected. Only
 * the title is taken, and a rename started after the event supersedes the read.
 */
export function syncSessionTitle(runtime: ChatRuntime, event: ChatSessionTitleChangedEvent): void {
  const documentId = chatDocumentId(runtime.get());
  if (documentId === null || documentId !== event.documentId) return;
  if (!runtime.get().sessions.some((session) => session.id === event.sessionId)) return;
  const documentSeq = runtime.lifecycle.documentSequence;
  const titleKey = titleRefreshKey(event.sessionId);
  const titleSeq = runtime.summaries.next(titleKey);
  void bridge.chat.getSession(event.sessionId, documentId).then((updated) => {
    if (!updated) return;
    if (!runtime.lifecycle.isCurrentDocument(documentSeq) || !runtime.summaries.isCurrent(titleKey, titleSeq)) return;
    runtime.set((current) => ({
      sessions: current.sessions.map((session) => (session.id === updated.id ? { ...session, title: updated.title } : session)),
    }));
  }, () => undefined);
}

/**
 * Re-reads one conversation's stored summary after a turn ends so the
 * Conversations screen shows the message count, preview and update time the
 * database actually holds.
 *
 * Only those three fields are taken. Title, provider, model and archive state
 * belong to the actions that write them, and this read can be in flight while
 * the user renames the conversation or rebinds its provider, so applying the
 * whole record would resurrect the values the read started with. The sequence
 * numbers make a stale answer — an older refresh landing after a newer one, or
 * one arriving after the document changed — a no-op instead of a rollback.
 */
export function syncSessionSummary(runtime: ChatRuntime, sessionId: string): void {
  const documentId = chatDocumentId(runtime.get());
  if (documentId === null) return;
  const documentSeq = runtime.lifecycle.documentSequence;
  const summarySeq = runtime.summaries.next(sessionId);
  void bridge.chat.getSession(sessionId, documentId).then((updated) => {
    if (!updated) return;
    if (!runtime.lifecycle.isCurrentDocument(documentSeq) || !runtime.summaries.isCurrent(sessionId, summarySeq)) return;
    runtime.set((current) => ({
      sessions: current.sessions.map((session) =>
        session.id === updated.id
          ? {
              ...session,
              messageCount: updated.messageCount,
              previewText: updated.previewText,
              updatedAt: new Date(Math.max(Date.parse(session.updatedAt), Date.parse(updated.updatedAt))).toISOString(),
            }
          : session
      ),
    }));
  }, () => undefined);
}
