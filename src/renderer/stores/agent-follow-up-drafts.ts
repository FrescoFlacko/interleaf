import { create } from 'zustand';

/**
 * A run's follow-up field and what it has been asked since it started. The
 * resume composer unmounts while its run is live, so this is kept outside it,
 * per session: a draft typed during a resume, and the follow-ups already sent,
 * are still there when the run ends. Resume prompts are not part of the session
 * record main returns, so they are remembered here, for this window only —
 * nothing is stored and nothing leaves the renderer.
 */
export type AgentFollowUp = {
  readonly draft: string;
  /** Follow-ups resumed in this window, oldest first. */
  readonly resumedPrompts: readonly string[];
};

const EMPTY_FOLLOW_UP: AgentFollowUp = { draft: '', resumedPrompts: [] };

/** Runs remembered at once; the least recently touched is forgotten first. */
const MAX_REMEMBERED_SESSIONS = 32;

type FollowUpState = { readonly bySession: ReadonlyMap<string, AgentFollowUp> };

const useFollowUpStore = create<FollowUpState>(() => ({ bySession: new Map() }));

function updateFollowUp(sessionId: string, change: (current: AgentFollowUp) => AgentFollowUp): void {
  useFollowUpStore.setState(({ bySession }) => {
    const next = new Map(bySession);
    const current = next.get(sessionId) ?? EMPTY_FOLLOW_UP;
    next.delete(sessionId);
    next.set(sessionId, change(current));
    for (const oldest of next.keys()) {
      if (next.size <= MAX_REMEMBERED_SESSIONS) break;
      next.delete(oldest);
    }
    return { bySession: next };
  });
}

export function useAgentFollowUp(sessionId: string): AgentFollowUp {
  return useFollowUpStore((state) => state.bySession.get(sessionId) ?? EMPTY_FOLLOW_UP);
}

export function setAgentFollowUpDraft(sessionId: string, draft: string): void {
  updateFollowUp(sessionId, (current) => ({ ...current, draft }));
}

/**
 * Records a follow-up the run accepted, however it was sent. The field is
 * cleared only if it still holds what was sent: anything typed while the
 * resume was in flight is the reader's next idea and is kept.
 */
export function recordAgentFollowUp(sessionId: string, prompt: string): void {
  updateFollowUp(sessionId, (current) => ({
    draft: current.draft === prompt ? '' : current.draft,
    resumedPrompts: [...current.resumedPrompts, prompt],
  }));
}

/** For tests: forget every run's follow-ups. */
export function resetAgentFollowUps(): void {
  useFollowUpStore.setState({ bySession: new Map() });
}
