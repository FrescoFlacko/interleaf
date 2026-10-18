import { useEffect, useRef, useState } from 'react';
import type { ChatContextBudget, ChatContextItem, ChatSession } from '@shared/types/ai';
import { useChatStore } from '../../stores/use-chat-store';
import { bridge } from '../../app/api-client';

type ContextBudgetInput = {
  readonly session: ChatSession | null;
  readonly contextItems: readonly ChatContextItem[];
  readonly isStreaming: boolean;
};

/**
 * The binding a displayed budget must belong to: the session, the provider and
 * model it is currently bound to, and the provider configuration in force. A
 * budget packed under any other binding describes a different request and may
 * never be shown against this one.
 *
 * The revision is part of the identity because the session row is not the whole
 * binding: a session stored as `openrouter/auto` keeps that id while Settings
 * moves the configured OpenRouter model from one to another, and main then
 * packs against a different model than the one already on screen. The renderer
 * never resolves the effective model itself — it only knows that the
 * configuration was re-read, which is enough to stop showing the old figure and
 * ask main again.
 */
function bindingKey(session: ChatSession | null, providerBindingRevision: number): string {
  if (session === null) return '';
  return `${session.id}|${session.providerId}|${session.modelId ?? ''}|${String(providerBindingRevision)}`;
}

/**
 * Everything that can move the budget: the binding above, plus the stored
 * message count, the pinned context set, and the start and end of a stream —
 * each marks a point where main may have packed a new request, or where a read
 * already in flight has to be abandoned.
 */
function budgetSignature(input: ContextBudgetInput, binding: string): string {
  const items = input.contextItems.map((item) => item.id).join(',');
  const messageCount = input.session?.messageCount ?? 0;
  return `${binding}|${String(messageCount)}|${String(input.isStreaming)}|${items}`;
}

/** A budget and the binding it was read for; the two are only ever used together. */
type BudgetState = {
  readonly bindingKey: string;
  readonly budget: ChatContextBudget | null;
};

const NOTHING: BudgetState = { bindingKey: '', budget: null };

/**
 * The main-owned budget of the active session's last packed request, or `null`
 * when there is nothing truthful to show.
 *
 * The renderer computes nothing: it asks main and displays the answer. Four
 * rules keep the displayed figure honest:
 *
 * - A budget is only rendered while the binding it was read for is still the
 *   active one. The comparison happens during render, so switching session,
 *   provider or model — or saving provider settings that can move the effective
 *   model of a session whose stored row never changes — blanks the readout in
 *   the same commit as the change rather than leaving the previous model's
 *   numbers on screen while a refresh is in flight, or indefinitely if that
 *   refresh never resolves.
 * - Nothing is read while a turn is streaming. Main records what it packed
 *   before the provider emits a token, so a read taken during the answer would
 *   return the request being answered right now and the indicator would present
 *   it as the last completed one. The previously completed request stays on
 *   screen for the length of the turn — or nothing does, before the first
 *   answer — and the new figure is only promoted once the stream ends.
 * - Only the newest read may write state. A slow earlier reply, or one for a
 *   session that has since been closed, is discarded rather than painted over
 *   a newer one.
 * - A reply is also dropped unless main answered for the same session and
 *   provider that asked. Main resolves the effective model itself, so its model
 *   identifier is the answer to that question, never a value to validate against.
 * - Any failure — no bridge, an invalid payload, a deleted session — resolves to
 *   `null` and the indicator disappears, rather than freezing on a stale value.
 */
export function useContextBudget(input: ContextBudgetInput): ChatContextBudget | null {
  const [state, setState] = useState<BudgetState>(NOTHING);
  const providerBindingRevision = useChatStore((chat) => chat.providerBindingRevision);
  const sessionId = input.session?.id ?? null;
  const providerId = input.session?.providerId ?? null;
  const isStreaming = input.isStreaming;
  const binding = bindingKey(input.session, providerBindingRevision);
  const signature = budgetSignature(input, binding);
  const latestRead = useRef(0);

  useEffect(() => {
    // Claiming the newest read number first is what abandons anything still in
    // flight: a reply asked for before this turn began cannot commit once the
    // turn has started, so a slow read cannot smuggle the in-progress packing
    // in behind the streaming guard below.
    const read = latestRead.current + 1;
    latestRead.current = read;
    if (isStreaming) return;
    if (sessionId === null || providerId === null) {
      setState(NOTHING);
      return;
    }
    void bridge.chat
      .getContextBudget(sessionId)
      .then((next) => {
        if (read !== latestRead.current) return;
        const matches = next === null || (next.sessionId === sessionId && next.providerId === providerId);
        setState({ bindingKey: binding, budget: matches ? next : null });
      })
      .catch(() => {
        if (read === latestRead.current) setState({ bindingKey: binding, budget: null });
      });
  }, [binding, signature, sessionId, providerId, isStreaming]);

  if (state.bindingKey !== binding) return null;
  return state.budget;
}
