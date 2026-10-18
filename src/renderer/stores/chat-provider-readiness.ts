import type { AIProviderId, AIProviderStatus, ChatSession, ReasoningEffort } from '@shared/types/ai';
import { displayProviderName } from '../features/chat/chat-labels';
import { isEffortStale, staleEffortMessage } from './chat-reasoning';

/**
 * How provider discovery stands for the document the chat store is showing.
 *
 * `loading` is a probe that is running now; `failed` is a probe that ran and
 * could not answer. In both cases readiness is unknown, and the provider
 * objects the store still holds are label metadata left over from an earlier
 * document or an earlier probe. They may name a provider a conversation is
 * bound to; they never say a turn can be dispatched. Only `succeeded` means the
 * list in the store came back from the probe for the document now open.
 */
export type ProviderDiscoveryState = 'loading' | 'succeeded' | 'failed';

/** Everything a readiness decision is allowed to read. */
export type ProviderReadinessView = {
  readonly providers: readonly AIProviderStatus[];
  readonly providerDiscovery: ProviderDiscoveryState;
};

const DISCOVERY_PENDING_MESSAGE =
  'Still checking which AI providers are ready. Try again once that check finishes.';
const DISCOVERY_FAILED_MESSAGE =
  'Could not check which AI providers are ready. Open Settings to check your providers, then try again.';
const NO_READY_PROVIDER_MESSAGE =
  'No AI provider is configured and ready for Reader Chat. Open Settings to configure.';
const MISSING_SESSION_MESSAGE =
  'This conversation is no longer open, so the message was not sent. Reopen it and try again.';
/** Mirrors main's own refusal, which is the authority on this. */
export const CLEANING_SESSION_MESSAGE =
  'This conversation is being cleaned. Wait for that to finish and try again.';

export function isProviderReady(status: AIProviderStatus): boolean {
  return (
    status.available &&
    (status.capabilities.toolFreeMode || status.id === 'codex') &&
    status.authentication === 'connected'
  );
}

/**
 * The providers a turn may actually be dispatched to right now.
 *
 * Empty whenever discovery has not succeeded for the open document, so a list
 * carried over from the previous document cannot authorize anything while the
 * new probe is still running or after it failed.
 */
export function actionableProviders(view: ProviderReadinessView): readonly AIProviderStatus[] {
  if (view.providerDiscovery !== 'succeeded') return [];
  return view.providers.filter(isProviderReady);
}

/** Whether a current, successful probe says this provider can run a turn now. */
export function isProviderActionable(
  view: ProviderReadinessView,
  providerId: AIProviderId | null | undefined
): boolean {
  if (providerId === null || providerId === undefined) return false;
  return actionableProviders(view).some((provider) => provider.id === providerId);
}

function providerUnavailableMessage(
  providerName: string,
  providerError: string | null | undefined
): string {
  return providerError ?? `${providerName} is unavailable for Reader Chat. Configure or authenticate it in Settings, then retry.`;
}

/**
 * Why nothing may be concluded from the retained provider list right now, or
 * `null` once a current probe has succeeded.
 *
 * This is the weakest gate: it asks only whether the list is an answer to the
 * question being asked, which is what an action that does not itself dispatch a
 * turn — rebinding a conversation, say — has to establish.
 */
export function discoveryBlockMessage(view: ProviderReadinessView): string | null {
  if (view.providerDiscovery === 'loading') return DISCOVERY_PENDING_MESSAGE;
  if (view.providerDiscovery === 'failed') return DISCOVERY_FAILED_MESSAGE;
  return null;
}

/**
 * Why an action bound to `providerId` may not be dispatched right now, or
 * `null` when a successful current probe says it may.
 *
 * `providerId` of `null` asks the weaker question — whether any provider is
 * ready — which is what creating a session without an explicit choice needs.
 * Every caller is expected to fail closed on a message: an unfinished or failed
 * probe is not permission, however recently the retained list was true.
 */
function providerBlockMessage(
  view: ProviderReadinessView,
  providerId: AIProviderId | null
): string | null {
  const stale = discoveryBlockMessage(view);
  if (stale !== null) return stale;
  if (providerId === null) {
    return view.providers.some(isProviderReady) ? null : NO_READY_PROVIDER_MESSAGE;
  }
  const requested = view.providers.find((provider) => provider.id === providerId);
  if (requested && isProviderReady(requested)) return null;
  return providerUnavailableMessage(displayProviderName(providerId, requested?.name), requested?.errorMessage);
}

/**
 * Folds a persisted chat default into a request for a **new** conversation.
 *
 * An explicit choice always wins, and the default's model is only carried when
 * the default's provider is the one being used — a model from one provider must
 * never be attached to another. The result is still put through
 * `resolveNewSessionBinding`, so a default that is no longer ready fails with a
 * named message rather than falling back to some other, possibly paid, provider.
 *
 * Existing conversations never consult this: they keep their stored binding.
 */
export function applyDefaultChatBinding(
  requestedProviderId: AIProviderId | undefined,
  requestedModelId: string | null | undefined,
  defaultChat: { readonly providerId: AIProviderId; readonly modelId: string | null } | null | undefined
): { readonly providerId: AIProviderId | undefined; readonly modelId: string | null | undefined } {
  if (requestedProviderId !== undefined) return { providerId: requestedProviderId, modelId: requestedModelId };
  if (defaultChat === null || defaultChat === undefined) {
    return { providerId: undefined, modelId: requestedModelId };
  }
  return { providerId: defaultChat.providerId, modelId: requestedModelId ?? defaultChat.modelId };
}

/**
 * A binding the reader has chosen for an existing conversation that the stored
 * session does not carry yet.
 *
 * It exists because the choice and the row are not updated in the same instant:
 * main re-validates readiness and writes the row, and in between the store holds
 * a conversation whose persisted provider is no longer the one the reader asked
 * for. A turn sent in that window would be spawned from the old provider —
 * possibly a paid one the reader was moving away from — so the intent is
 * recorded and the send is refused until it settles.
 *
 * `failed` is kept rather than discarded: a refused rebinding leaves the reader
 * having asked for one provider and the row carrying another, and falling back
 * to the row is the silent substitution this whole path exists to prevent.
 */
export type SessionBindingIntent = {
  readonly sessionId: string;
  /** The document the choice was made in; a stale one never applies. */
  readonly documentId: string;
  readonly providerId: AIProviderId;
  readonly modelId: string | null;
  /** Chosen with the model, as one decision; `null` is Default. */
  readonly reasoningEffort: ReasoningEffort | null;
  readonly status: 'pending' | 'failed';
  /** Main's words when the rebinding was refused, else `null`. */
  readonly error: string | null;
};

/** Unsettled and failed bindings, by session. Absent means the row is the truth. */
export type SessionBindingIntents = Readonly<Record<string, SessionBindingIntent>>;

function bindingPendingMessage(intent: SessionBindingIntent): string {
  return `Still moving this conversation to ${displayProviderName(intent.providerId, null)}. Try again once that finishes.`;
}

function bindingFailedMessage(intent: SessionBindingIntent): string {
  return (
    intent.error ??
    `Could not move this conversation to ${displayProviderName(intent.providerId, null)}, so nothing was sent. Choose a provider again.`
  );
}

/**
 * Why a conversation's binding cannot authorize a turn right now, or `null`
 * when the stored row is the reader's latest choice.
 */
function bindingBlockMessage(
  intents: SessionBindingIntents | undefined,
  sessionId: string
): string | null {
  const intent = intents?.[sessionId];
  if (intent === undefined) return null;
  return intent.status === 'pending' ? bindingPendingMessage(intent) : bindingFailedMessage(intent);
}

/** Readiness plus the conversations a session id can be resolved against. */
export type SessionReadinessView = ProviderReadinessView & {
  readonly sessions: readonly ChatSession[];
  /** Choices this store is still reconciling with the stored rows. */
  readonly bindingIntents: SessionBindingIntents;
};

/**
 * Why the provider a conversation is bound to may not run a turn right now, or
 * `null` when a current, successful probe says it may.
 *
 * Asked twice per turn, and deliberately so: once when the send is admitted, and
 * again immediately before the turn would cross IPC. Discovery can be re-run and
 * fail in between, and a turn dispatched on the earlier answer would be using a
 * provider status this store no longer stands behind.
 *
 * A conversation that is not in the list is a refusal, not a licence to ask the
 * weaker "is any provider ready" question: whatever binding it had cannot be
 * read from a list it is absent from.
 */
export function sessionProviderBlockMessage(
  view: SessionReadinessView,
  sessionId: string
): string | null {
  const stale = discoveryBlockMessage(view);
  if (stale !== null) return stale;
  const session = view.sessions.find((item) => item.id === sessionId);
  if (session === undefined) return MISSING_SESSION_MESSAGE;
  // Asked before the row, and never instead of it: while the reader's choice and
  // the stored binding disagree, the row is not an answer to "what would this
  // turn be spawned from". Both send gates come through here, so a direct store
  // call and a fast second submission are refused on the same terms as the
  // composer.
  const unsettled = bindingBlockMessage(view.bindingIntents, sessionId);
  if (unsettled !== null) return unsettled;
  const blocked = providerBlockMessage(view, session.providerId);
  if (blocked !== null) return blocked;
  // A saved level the model no longer offers is shown and refused, never
  // swapped for another one; main refuses it on the same terms.
  if (session.reasoningEffort !== null && isEffortStale(view.providers, session)) {
    return staleEffortMessage(session.reasoningEffort);
  }
  return null;
}

/** Everything the send gate reads, beyond provider readiness itself. */
export type SendReadinessView = SessionReadinessView & {
  readonly isStreaming: boolean;
  /** A `Clean Context` request is in flight for the conversation in view. */
  readonly isCleaningContext: boolean;
};

/**
 * Whether a turn may be sent, and what to tell the reader when it may not.
 *
 * `error` is `null` for the cases the composer already prevents — no text, a
 * turn already in flight — because those are not failures worth reporting. A
 * provider that no current probe reports as ready is different: the reader
 * asked for something and it did not happen, so it is named.
 */
export type SendGate = { readonly allowed: true } | { readonly allowed: false; readonly error: string | null };

export function evaluateSendGate(
  view: SendReadinessView,
  sessionId: string,
  trimmedContent: string
): SendGate {
  if (trimmedContent === '' || view.isStreaming) return { allowed: false, error: null };
  // A clean is a mutation of the very transcript this turn would extend, and main
  // refuses the send outright. Named rather than silent: the reader asked for
  // something, and the composer keeps their draft.
  if (view.isCleaningContext) return { allowed: false, error: CLEANING_SESSION_MESSAGE };
  const blocked = sessionProviderBlockMessage(view, sessionId);
  return blocked === null ? { allowed: true } : { allowed: false, error: blocked };
}

/** The provider and model a new conversation would be created with, or why it cannot be. */
export type NewSessionBinding =
  | { readonly ok: true; readonly providerId: AIProviderId; readonly modelId: string | null }
  | { readonly ok: false; readonly error: string };

/**
 * Resolves the binding for a new conversation from current readiness only.
 *
 * An explicitly chosen provider must itself be actionable — a chosen provider
 * that is not ready fails rather than silently falling back to another one —
 * and an unchosen provider comes from the actionable list, never from retained
 * metadata.
 */
export function resolveNewSessionBinding(
  view: ProviderReadinessView,
  requestedProviderId: AIProviderId | undefined,
  requestedModelId: string | null | undefined
): NewSessionBinding {
  const blocked = providerBlockMessage(view, requestedProviderId ?? null);
  if (blocked !== null) return { ok: false, error: blocked };
  const providerId = requestedProviderId ?? actionableProviders(view)[0]?.id;
  if (providerId === undefined) return { ok: false, error: NO_READY_PROVIDER_MESSAGE };
  const providerInfo = view.providers.find((provider) => provider.id === providerId);
  return { ok: true, providerId, modelId: requestedModelId ?? providerInfo?.models[0]?.id ?? null };
}
