import { AI_PROVIDER_IDS } from '@shared/constants/ai';
import type { AppSettings } from '@shared/schemas/settings';
import { BUILT_IN_AGENT_PROFILE_IDS } from '@shared/schemas/settings';
import { selectableAgentRows, selectableChatRows, type OnboardingProviderRow } from './onboarding-rows';

/**
 * Step 3 — what each mode reaches for first.
 *
 * Everything here is a *draft*: an option list derived from live detection, a
 * user edit that has not been written anywhere, and a resolution between the
 * two. Nothing in this module reads a credential, starts a process or grants a
 * permission; the only thing it can produce is the pair of choices the wizard's
 * single Continue writes.
 *
 * Resolution is deliberately conservative. A stored default is honoured only
 * while it is still one of the detected options, and a model is honoured only
 * while the provider still lists it — an id that no longer exists becomes "let
 * the provider choose" rather than a silent binding to something else.
 */

/**
 * The provider ids a default may be persisted as.
 *
 * Narrower than `AIProviderId` on purpose: `fake` is a test-only compile-time
 * member that the settings schema rejects, so it cannot become a stored
 * preference.
 */
export type PersistableChatProviderId = NonNullable<AppSettings['ai']['defaultChat']>['providerId'];

export function isPersistableChatProviderId(value: string): value is PersistableChatProviderId {
  return (AI_PROVIDER_IDS as readonly string[]).includes(value);
}

/** The built-in profile ids a default may be persisted as (§5.2). */
export type PersistableAgentProfileId = NonNullable<AppSettings['agent']['defaultProfileId']>;

export function isPersistableAgentProfileId(value: string): value is PersistableAgentProfileId {
  return (BUILT_IN_AGENT_PROFILE_IDS as readonly string[]).includes(value);
}

export type DefaultOption = {
  readonly id: string;
  readonly name: string;
  /** Catalog ids as detected. Empty means the runtime's own default is used. */
  readonly models: readonly string[];
};

/** A provider/model pair, or `null` for "nothing valid to choose". */
export type DefaultChoice = { readonly id: string; readonly modelId: string | null } | null;

/** Reader Chat options: rows detection already found selectable for chat. */
export function chatDefaultOptions(rows: readonly OnboardingProviderRow[]): readonly DefaultOption[] {
  return selectableChatRows(rows).flatMap((row) =>
    row.chatProviderId !== null && isPersistableChatProviderId(row.chatProviderId)
      ? [{ id: row.chatProviderId, name: row.name, models: row.chat?.models ?? [] }]
      : []
  );
}

/** Agent Mode options: built-in profiles only, as the settings schema requires. */
export function agentDefaultOptions(rows: readonly OnboardingProviderRow[]): readonly DefaultOption[] {
  return selectableAgentRows(rows).flatMap((row) =>
    isPersistableAgentProfileId(row.id) ? [{ id: row.id, name: row.name, models: row.agent?.models ?? [] }] : []
  );
}

function optionFor(options: readonly DefaultOption[], id: string | null | undefined): DefaultOption | undefined {
  return id === null || id === undefined ? undefined : options.find((option) => option.id === id);
}

function withValidModel(option: DefaultOption, modelId: string | null): DefaultChoice {
  return { id: option.id, modelId: modelId !== null && option.models.includes(modelId) ? modelId : null };
}

/**
 * The selection a section shows and Continue would commit.
 *
 * Precedence is the user's own edit, then a persisted default that is still
 * available, then the first ready option. The last step is a suggestion, not a
 * commitment: it is written only if the user presses Continue.
 */
export function resolveDefaultChoice(
  options: readonly DefaultOption[],
  persisted: DefaultChoice,
  draft: DefaultChoice
): DefaultChoice {
  const drafted = optionFor(options, draft?.id);
  if (drafted !== undefined) return withValidModel(drafted, draft?.modelId ?? null);

  const stored = optionFor(options, persisted?.id);
  if (stored !== undefined) return withValidModel(stored, persisted?.modelId ?? null);

  const first = options[0];
  return first === undefined ? null : { id: first.id, modelId: null };
}

/** The persisted Reader Chat default, in the shape resolution expects. */
export function persistedChatChoice(settings: AppSettings | null): DefaultChoice {
  const stored = settings?.ai.defaultChat ?? null;
  return stored === null ? null : { id: stored.providerId, modelId: stored.modelId };
}

/** The persisted Agent Mode default, including its per-profile model. */
export function persistedAgentChoice(settings: AppSettings | null): DefaultChoice {
  const profileId = settings?.agent.defaultProfileId ?? null;
  if (profileId === null) return null;
  return { id: profileId, modelId: settings?.agent.profiles[profileId]?.defaultModel ?? null };
}
