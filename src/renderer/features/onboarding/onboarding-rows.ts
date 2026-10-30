import { aiProviderDisplayName } from '@shared/constants/ai';
import type { AIProviderId, AIProviderStatus } from '@shared/types/ai';
import type { AgentProfileStatus } from '@shared/types/agent';
import { isProviderReady } from '../../stores/chat/provider-readiness';
import { sanitizeProviderVersion, type OpenRouterCredentialState, type ProviderRowTone } from '../settings/provider-rows';
import { PROFILE_EDITOR_DEFINITIONS } from '../agent/profile-preferences';

/**
 * The §4 detection/status/action matrix, as a pure function.
 *
 * Every state below is derived from a settled `AIProviderStatus` or
 * `AgentProfileStatus` **together with the row's kind**, because `installed`
 * does not mean the same thing across providers: OpenRouter always reports
 * `installed: false` and carries its state in `authentication`, and the local
 * provider's `installed` means "something answered on the loopback port". Only
 * CLI rows may read `installed === false` as "no executable was found".
 *
 * Chat readiness and agent readiness are separate readouts on the same row and
 * are never inferred from one another: a CLI's presence says nothing about chat
 * support, and an installed agent runtime is not an authenticated one.
 */

/** A per-row observation. `checking` is a UI state, never a detection result. */
export type RowProbe<T> =
  | { readonly phase: 'checking' }
  | { readonly phase: 'settled'; readonly value: T }
  | { readonly phase: 'failed'; readonly message: string };

type OnboardingRowState =
  | 'checking'
  | 'ready-chat'
  | 'ready-agent'
  | 'installed-unverified'
  | 'sign-in-required'
  | 'api-key-missing'
  | 'local-unreachable'
  | 'not-installed'
  | 'unsupported'
  | 'empty-catalog'
  | 'unknown'
  | 'error';

export type OnboardingRowAction =
  | 'install-help'
  | 'add-openrouter-key'
  | 'configure-local-endpoint'
  | 'sign-in-chatgpt'
  /**
   * The existing `credentials:test` connectivity/catalog check (§7). It is not
   * inference and must never be labelled as a model call, so it is offered only
   * where an adapter already implements it and only once a key is present —
   * there is nothing to check before that.
   */
  | 'test-connection'
  | 'retry';

type OnboardingCapability = 'chat' | 'agent';

export type OnboardingCapabilityStatus = {
  readonly capability: OnboardingCapability;
  readonly state: OnboardingRowState;
  readonly label: string;
  readonly tone: ProviderRowTone;
  /** A main-supplied safe message, never raw probe output. */
  readonly detail: string | null;
  /** Whether the user may confirm this as their default for the capability. */
  readonly selectable: boolean;
  /** Catalog identifiers, empty when nothing was listed. Never invented. */
  readonly models: readonly string[];
  readonly actions: readonly OnboardingRowAction[];
};

export type OnboardingProviderRow = {
  readonly id: string;
  readonly name: string;
  readonly kind: 'openrouter' | 'agent' | 'chat-cli' | 'local';
  /** The chat provider this row speaks for, or `null` when it serves no chat. */
  readonly chatProviderId: AIProviderId | null;
  readonly version: string | null;
  /** Reader Chat readout, or `null` when this entity serves no chat provider. */
  readonly chat: OnboardingCapabilityStatus | null;
  /** Agent Mode readout, or `null` when this entity has no agent profile. */
  readonly agent: OnboardingCapabilityStatus | null;
  readonly statusLabel: string;
  readonly tone: ProviderRowTone;
};

/**
 * Which built-in agent profile transports which Reader Chat provider.
 *
 * Mapping only — it grants nothing. It exists so a row can show both readouts
 * for the same installed CLI without either being derived from the other.
 *
 * `cursor` is deliberately absent, like `opencode`: it is
 * registered as a chat provider id so the provider listing stays complete, but
 * it carries a permanent `chatUnavailableReason`, so its row states Agent Mode
 * alone rather than showing a Reader Chat readout it could never satisfy.
 */
const CHAT_PROVIDER_BY_PROFILE: Readonly<Record<string, AIProviderId | undefined>> = {
  codex: 'codex',
  'claude-code': 'claude',
  antigravity: 'antigravity',
  pi: 'pi',
};

const CHAT_ONLY_PROVIDER_IDS: readonly AIProviderId[] = ['openrouter', 'local', 'omp'];

const LABELS = {
  checking: 'Checking…',
  readyChat: 'Ready for Reader Chat',
  readyAgent: 'Ready for Agent Mode',
  installedUnverified: 'Installed — sign-in not verified',
  signIn: 'Sign-in required',
  apiKey: 'API key not added',
  localDown: 'No local server responding',
  notInstalled: 'Not installed',
  emptyCatalog: 'Connected — no models listed',
  unknown: 'Could not verify',
  unavailable: 'Unavailable',
  chatOnly: 'Reader Chat only',
  agentOnly: 'Agent Mode only',
} as const;

const RUNTIME_DEFAULT_MODEL_DETAIL =
  'No model list was reported, so the runtime’s own default model will be used.';

const UNREADABLE_KEY_DETAIL =
  'A key is stored but could not be read back, so it cannot be used. Add it again to replace it.';

const UNVERIFIED_AGENT_DETAIL =
  'Interleaf found this runtime on your machine. It has not checked that it is signed in, so a run is not guaranteed to succeed.';

/** Bounded, non-actionable text: provider messages are untrusted external copy. */
const MAX_DETAIL_LENGTH = 300;

function safeDetail(message: string | null | undefined): string | null {
  if (typeof message !== 'string') return null;
  const cleaned = message.replace(/\s+/gu, ' ').trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > MAX_DETAIL_LENGTH ? `${cleaned.slice(0, MAX_DETAIL_LENGTH - 1)}…` : cleaned;
}

function capability(
  kind: OnboardingCapability,
  state: OnboardingRowState,
  label: string,
  tone: ProviderRowTone,
  extra: {
    readonly detail?: string | null;
    readonly selectable?: boolean;
    readonly models?: readonly string[];
    readonly actions?: readonly OnboardingRowAction[];
  } = {}
): OnboardingCapabilityStatus {
  return {
    capability: kind,
    state,
    label,
    tone,
    detail: extra.detail ?? null,
    selectable: extra.selectable ?? false,
    models: extra.models ?? [],
    actions: extra.actions ?? [],
  };
}

function checkingCapability(kind: OnboardingCapability): OnboardingCapabilityStatus {
  return capability(kind, 'checking', LABELS.checking, 'unavailable');
}

function unknownCapability(kind: OnboardingCapability, detail: string | null): OnboardingCapabilityStatus {
  // `unknown` is never rendered as signed out and never as ready (§4 rule 1).
  return capability(kind, 'unknown', LABELS.unknown, 'attention', { detail, actions: ['retry'] });
}

function modelIds(status: AIProviderStatus): readonly string[] {
  return status.models.map((model) => model.id);
}

/** OpenRouter: an account, not an installation. Its state is the credential. */
function openRouterChat(
  probe: RowProbe<AIProviderStatus>,
  credential: OpenRouterCredentialState
): OnboardingCapabilityStatus {
  if (credential === 'stored-unreadable') {
    return capability('chat', 'error', LABELS.unavailable, 'attention', {
      detail: UNREADABLE_KEY_DETAIL,
      actions: ['add-openrouter-key'],
    });
  }
  if (credential === 'absent') {
    return capability('chat', 'api-key-missing', LABELS.apiKey, 'attention', {
      actions: ['add-openrouter-key'],
    });
  }
  if (probe.phase === 'checking') return checkingCapability('chat');
  if (probe.phase === 'failed') return unknownCapability('chat', probe.message);
  const status = probe.value;
  if (status.authentication === 'error') {
    return capability('chat', 'error', LABELS.unavailable, 'attention', {
      detail: safeDetail(status.errorMessage),
      actions: ['retry', 'add-openrouter-key'],
    });
  }
  if (status.authentication === 'unknown') return unknownCapability('chat', safeDetail(status.errorMessage));
  if (status.authentication === 'disconnected') {
    return capability('chat', 'api-key-missing', LABELS.apiKey, 'attention', {
      actions: ['add-openrouter-key'],
    });
  }
  if (status.models.length === 0) {
    return capability('chat', 'empty-catalog', LABELS.emptyCatalog, 'attention', {
      actions: ['test-connection', 'retry'],
    });
  }
  return capability('chat', 'ready-chat', LABELS.readyChat, 'ready', {
    selectable: isProviderReady(status),
    models: modelIds(status),
    actions: ['test-connection'],
  });
}

/**
 * The loopback server: `installed` means something answered on the port, so it
 * is never rendered as "not installed" and never asked to sign in.
 */
function localChat(probe: RowProbe<AIProviderStatus>): OnboardingCapabilityStatus {
  if (probe.phase === 'checking') return checkingCapability('chat');
  if (probe.phase === 'failed') return unknownCapability('chat', probe.message);
  const status = probe.value;
  if (status.authentication === 'error') {
    return capability('chat', 'error', LABELS.unavailable, 'attention', {
      detail: safeDetail(status.errorMessage),
      actions: ['retry', 'configure-local-endpoint'],
    });
  }
  if (!status.installed) {
    return capability('chat', 'local-unreachable', LABELS.localDown, 'unavailable', {
      detail: safeDetail(status.errorMessage),
      actions: ['configure-local-endpoint'],
    });
  }
  if (status.models.length === 0) {
    return capability('chat', 'empty-catalog', LABELS.emptyCatalog, 'attention', {
      actions: ['retry', 'configure-local-endpoint'],
    });
  }
  return capability('chat', 'ready-chat', LABELS.readyChat, 'ready', {
    selectable: isProviderReady(status),
    models: modelIds(status),
  });
}

/**
 * A CLI that serves Reader Chat.
 *
 * `installed === false` here is established absence — `CliAIProvider.detect`
 * only reports it when resolving the executable raised `ENOENT` — so this is
 * the one kind where installation help is offered.
 */
function cliChat(probe: RowProbe<AIProviderStatus>, hasAgentProfile: boolean): OnboardingCapabilityStatus {
  if (probe.phase === 'checking') return checkingCapability('chat');
  if (probe.phase === 'failed') return unknownCapability('chat', probe.message);
  const status = probe.value;
  if (status.authentication === 'error') {
    return capability('chat', 'error', LABELS.unavailable, 'attention', {
      detail: safeDetail(status.errorMessage),
      actions: ['retry'],
    });
  }
  if (!status.installed) {
    return capability('chat', 'not-installed', LABELS.notInstalled, 'unavailable', {
      actions: ['install-help'],
    });
  }
  if (status.authentication === 'unknown') return unknownCapability('chat', safeDetail(status.errorMessage));
  if (status.authentication === 'disconnected') {
    return capability('chat', 'sign-in-required', LABELS.signIn, 'attention', {
      detail: safeDetail(status.errorMessage),
      actions: status.id === 'codex' ? ['sign-in-chatgpt', 'retry'] : ['retry'],
    });
  }
  // Connected, but the capability may still be unsupported for chat: Antigravity
  // carries a permanent `chatUnavailableReason`, and Codex is reachable without
  // a tool-free mode (its accepted residual risk).
  if (!isProviderReady(status)) {
    return capability('chat', 'unsupported', hasAgentProfile ? LABELS.agentOnly : LABELS.unavailable, 'unavailable', {
      detail: safeDetail(status.errorMessage),
    });
  }
  if (status.models.length === 0) {
    return capability('chat', 'empty-catalog', LABELS.emptyCatalog, 'attention', { actions: ['retry'] });
  }
  return capability('chat', 'ready-chat', LABELS.readyChat, 'ready', {
    selectable: true,
    models: modelIds(status),
  });
}

/**
 * An agent runtime.
 *
 * Installation is not authentication (§4 rule 3): where nothing establishes a
 * sign-in, the row says so and the runtime stays selectable, because every
 * launch gate — grant, permission mode, execution mode, profile validation —
 * is still enforced when a run actually starts.
 *
 * `unsupported` never offers installation help (§4 rule 6): a runtime main
 * refuses outright is reported `not-installed` without being probed, so its
 * absence is a product decision rather than evidence the binary is missing.
 */
function agentCapability(
  status: AgentProfileStatus | undefined,
  pending: boolean,
  chatAuthenticated: boolean
): OnboardingCapabilityStatus {
  if (status === undefined) {
    return pending ? checkingCapability('agent') : unknownCapability('agent', null);
  }
  const detail = safeDetail(status.errorMessage);
  if (status.availability === 'error') {
    return capability('agent', 'error', LABELS.unavailable, 'attention', { detail, actions: ['retry'] });
  }
  if (status.unavailability === 'unsupported') {
    return capability('agent', 'unsupported', LABELS.unavailable, 'unavailable', { detail });
  }
  if (status.availability !== 'installed') {
    return capability('agent', 'not-installed', LABELS.notInstalled, 'unavailable', { actions: ['install-help'] });
  }
  const models = status.supportsModelSelection ? status.availableModels : [];
  const catalogDetail = models.length === 0 ? RUNTIME_DEFAULT_MODEL_DETAIL : null;
  if (chatAuthenticated) {
    return capability('agent', 'ready-agent', LABELS.readyAgent, 'ready', {
      selectable: true,
      models,
      detail: catalogDetail,
    });
  }
  return capability('agent', 'installed-unverified', LABELS.installedUnverified, 'attention', {
    selectable: true,
    models,
    detail: catalogDetail ?? UNVERIFIED_AGENT_DETAIL,
    // Re-checking is the only honest offer here: nothing has established a
    // sign-in, and the wizard will not start the runtime to find out.
    actions: ['retry'],
  });
}

const TONE_RANK: Readonly<Record<ProviderRowTone, number>> = { ready: 2, attention: 1, unavailable: 0 };

/**
 * The single line the Discover stage shows for a row.
 *
 * It names the capability that is actually usable rather than merging the two
 * readouts into an average: a runtime that is ready for Agent Mode and
 * unsupported for chat must not read as generally "ready".
 */
function summarize(
  chat: OnboardingCapabilityStatus | null,
  agent: OnboardingCapabilityStatus | null
): { readonly statusLabel: string; readonly tone: ProviderRowTone } {
  const present = [chat, agent].filter((item): item is OnboardingCapabilityStatus => item !== null);
  if (present.length === 0) return { statusLabel: LABELS.unknown, tone: 'unavailable' };
  if (present.every((item) => item.state === 'checking')) {
    return { statusLabel: LABELS.checking, tone: 'unavailable' };
  }
  const best = present.reduce((winner, item) => (TONE_RANK[item.tone] > TONE_RANK[winner.tone] ? item : winner));
  return { statusLabel: best.label, tone: best.tone };
}

export type OnboardingRowInput = {
  /** One probe per chat provider id; absent ids are treated as still checking. */
  readonly chatProbes: Readonly<Partial<Record<AIProviderId, RowProbe<AIProviderStatus>>>>;
  readonly agentProfiles: readonly AgentProfileStatus[];
  /** The existing coalesced agent model discovery is still running. */
  readonly agentDiscoveryPending: boolean;
  /** Agent detection itself has not answered yet. */
  readonly agentDetectionPending: boolean;
  readonly openRouterCredential: OpenRouterCredentialState;
};

function chatProbeFor(
  input: OnboardingRowInput,
  providerId: AIProviderId | undefined
): RowProbe<AIProviderStatus> | undefined {
  if (providerId === undefined) return undefined;
  return input.chatProbes[providerId];
}

function settledChatStatus(probe: RowProbe<AIProviderStatus> | undefined): AIProviderStatus | undefined {
  return probe?.phase === 'settled' ? probe.value : undefined;
}

/**
 * Builds the wizard's row set: every supported integration, whether or not it
 * is present on this machine, so absence is stated rather than hidden.
 *
 * Custom agent profiles appear only because the user already configured them
 * and are never executed for discovery (§4 rule 5).
 */
export function deriveOnboardingRows(input: OnboardingRowInput): readonly OnboardingProviderRow[] {
  const rows: OnboardingProviderRow[] = [];

  const openRouterProbe = input.chatProbes.openrouter ?? { phase: 'checking' as const };
  const openRouterChatStatus = openRouterChat(openRouterProbe, input.openRouterCredential);
  rows.push({
    id: 'openrouter',
    name: aiProviderDisplayName('openrouter'),
    kind: 'openrouter',
    chatProviderId: 'openrouter',
    version: null,
    chat: openRouterChatStatus,
    agent: null,
    ...summarize(openRouterChatStatus, null),
  });

  const localProbe = input.chatProbes.local ?? { phase: 'checking' as const };
  const localChatStatus = localChat(localProbe);
  rows.push({
    id: 'local',
    name: aiProviderDisplayName('local'),
    kind: 'local',
    chatProviderId: 'local',
    version: null,
    chat: localChatStatus,
    agent: null,
    ...summarize(localChatStatus, null),
  });

  const agentDetectionPending = input.agentDetectionPending;
  for (const definition of PROFILE_EDITOR_DEFINITIONS) {
    const chatProviderId = CHAT_PROVIDER_BY_PROFILE[definition.id];
    const probe = chatProbeFor(input, chatProviderId);
    const chatStatus =
      chatProviderId === undefined
        ? null
        : cliChat(probe ?? { phase: 'checking' }, true);
    const profile = input.agentProfiles.find((candidate) => candidate.profileId === definition.id);
    const agentStatus = agentCapability(
      profile,
      agentDetectionPending || input.agentDiscoveryPending,
      settledChatStatus(probe)?.authentication === 'connected'
    );
    rows.push({
      id: definition.id,
      name: definition.name,
      kind: 'agent',
      chatProviderId: chatProviderId ?? null,
      version: sanitizeProviderVersion(settledChatStatus(probe)?.version ?? profile?.version ?? null),
      chat: chatStatus,
      agent: agentStatus,
      ...summarize(chatStatus, agentStatus),
    });
  }

  const ompProbe = input.chatProbes.omp ?? { phase: 'checking' as const };
  const ompChatStatus = cliChat(ompProbe, false);
  rows.push({
    id: 'omp',
    name: aiProviderDisplayName('omp'),
    kind: 'chat-cli',
    chatProviderId: 'omp',
    version: sanitizeProviderVersion(settledChatStatus(ompProbe)?.version ?? null),
    chat: ompChatStatus,
    agent: null,
    ...summarize(ompChatStatus, null),
  });

  // User-configured custom profiles: shown because they exist, never probed.
  for (const profile of input.agentProfiles) {
    if (!profile.isCustom) continue;
    const agentStatus = agentCapability(profile, agentDetectionPending, false);
    rows.push({
      id: `custom:${profile.profileId}`,
      name: profile.name,
      kind: 'agent',
      chatProviderId: null,
      version: sanitizeProviderVersion(profile.version),
      chat: null,
      agent: agentStatus,
      ...summarize(null, agentStatus),
    });
  }

  return rows;
}

/** Chat providers the user may confirm as their Reader Chat default. */
export function selectableChatRows(rows: readonly OnboardingProviderRow[]): readonly OnboardingProviderRow[] {
  return rows.filter((row) => row.chat?.selectable === true);
}

/** Built-in agent profiles the user may confirm as their Agent Mode default. */
export function selectableAgentRows(rows: readonly OnboardingProviderRow[]): readonly OnboardingProviderRow[] {
  return rows.filter((row) => row.agent?.selectable === true && !row.id.startsWith('custom:'));
}

/** Whether any row is still waiting on a check. Never gates *Continue*. */
export function hasPendingRows(rows: readonly OnboardingProviderRow[]): boolean {
  return rows.some((row) => row.chat?.state === 'checking' || row.agent?.state === 'checking');
}

/**
 * The chat provider ids the wizard asks main about, one call per row that shows
 * a Reader Chat readout.
 *
 * Derived from the two tables above rather than from `AI_PROVIDER_IDS`, so a
 * provider registered for listing completeness but mapped onto no row — today,
 * `cursor` — does not cost a check whose answer nothing would display.
 */
export const ONBOARDING_CHAT_PROVIDER_IDS: readonly AIProviderId[] = [
  ...CHAT_ONLY_PROVIDER_IDS,
  ...Object.values(CHAT_PROVIDER_BY_PROFILE).filter((id): id is AIProviderId => id !== undefined),
];
