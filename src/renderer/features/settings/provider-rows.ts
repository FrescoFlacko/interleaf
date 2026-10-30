import type { AIProviderStatus } from '@shared/types/ai';
import type { AgentDetection, AgentProfile } from '@shared/types/agent';
import type { OpenRouterKeyPreview } from '@shared/schemas/credential-preview';
import { PROFILE_EDITOR_DEFINITIONS } from '../agent/profile-preferences';

/** Dot colour scale shared by every provider row (design 5a). */
export type ProviderRowTone = 'ready' | 'attention' | 'unavailable';

export type ProviderRow = {
  /** Accordion identity; the built-in agent profile id for CLI rows. */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** CLI version reported by main, or `null` when nothing was detected. */
  readonly version: string | null;
  /** Plain right-aligned label; never a coloured pill. */
  readonly statusLabel: string;
  readonly tone: ProviderRowTone;
  /**
   * Which panel the row opens.
   *
   * `chat-cli` is a CLI that answers Reader Chat and has no Agent Mode profile
   * at all, so its panel is the connection block on its own rather than an
   * agent editor with an empty half. `local` is the loopback server, which
   * configures an endpoint instead of an account.
   */
  readonly kind: 'openrouter' | 'agent' | 'chat-cli' | 'local';
  /** Reader Chat is available from this provider, so the row shows its
   * connection and chat information as well as its agent profile. */
  readonly readerChat: boolean;
  /** The integration's CLI or app is absent, so Settings collapses the row
   * under "Not installed (n)" rather than listing it with the usable ones. */
  readonly notInstalled: boolean;
};

type ProfileDetection = Pick<AgentProfile, 'id' | 'detection'>;

/**
 * Which built-in profile maps onto a Reader Chat AI provider.
 *
 * `src/main/ai/providers/cli-ai-provider.ts` registers five CLI chat providers,
 * and Antigravity and Cursor each carry a permanent `chatUnavailableReason`, so
 * they are Agent-Mode-only integrations like OpenCode. This table
 * is the mapping only: every status below is read from live detection.
 */
const CHAT_PROVIDER_BY_PROFILE: Readonly<Record<string, string>> = {
  codex: 'codex',
  'claude-code': 'claude',
  pi: 'pi',
};

const AGENT_ONLY_LABEL = 'Agent Mode only';

const PROFILE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  codex: 'Signs in with your ChatGPT subscription. Reader Chat runs it read-only; Agent Mode uses the profile below.',
  'claude-code': 'Subscription-backed. Reader Chat runs it in safe tool-free mode; Agent Mode uses the profile below.',
  antigravity: 'Runs via Google account subscription tools. Available in Agent Mode only.',
  opencode: 'OpenCode CLI. Available in Agent Mode only.',
  cursor: 'Cursor CLI. Available in Agent Mode only.',
  pi: 'Subscription-backed. Reader Chat runs it in safe tool-free mode; Agent Mode uses the profile below.',
};

const OPENROUTER_DESCRIPTION =
  'Models via your OpenRouter account, using local OS-encrypted key storage.';

const OMP_DESCRIPTION =
  'Subscription-backed. Reader Chat only: Interleaf runs it without tools, and it has no Agent Mode profile.';

/**
 * Deliberately says "loopback server" and not "on-device".
 *
 * Interleaf's guarantee is about the socket; whether the runtime behind it
 * answers locally or forwards a cloud-capable model upstream is the runtime's
 * decision, and the panel explains that rather than the row overpromising it.
 */
const LOCAL_DESCRIPTION =
  'Ollama or another OpenAI-compatible server on this machine. Interleaf connects only to a loopback address.';

/**
 * What the OpenRouter credential can actually do, not merely whether a record
 * exists. `stored-unreadable` is main's fail-closed result — a stored key whose
 * masked preview could not be derived because decryption or parsing failed — so
 * the key cannot serve a provider call and must never read as Ready or Saved.
 */
export type OpenRouterCredentialState = 'absent' | 'stored-unreadable' | 'ready';

export function openRouterCredentialState(status: {
  readonly configured: boolean;
  readonly keyPreview: OpenRouterKeyPreview | null;
}): OpenRouterCredentialState {
  if (!status.configured) return 'absent';
  return status.keyPreview === null ? 'stored-unreadable' : 'ready';
}

const OPENROUTER_ROW_STATUS: Readonly<
  Record<OpenRouterCredentialState, { readonly label: string; readonly tone: ProviderRowTone }>
> = {
  absent: { label: 'Not configured', tone: 'attention' },
  'stored-unreadable': { label: 'Saved key unreadable', tone: 'attention' },
  ready: { label: 'Ready', tone: 'ready' },
};

/** Longest version string a row will show before it is cut short. */
const MAX_VERSION_LENGTH = 32;
const CONTROL_SEQUENCES = /\u001B\[[0-9;?]*[\u0020-\u002F]*[@-~]|[\u0000-\u001F\u007F]/gu;

/**
 * A CLI version is external process output, so it is untrusted text: escape
 * sequences, control bytes and trailing warning lines are removed before it is
 * rendered, and anything left over is bounded.
 */
export function sanitizeProviderVersion(version: string | null | undefined): string | null {
  if (typeof version !== 'string') return null;
  // Only the first line is the version; anything a CLI prints after it — a
  // warning, a banner — is dropped rather than shown as part of the row.
  const firstLine = version.split(/[\r\n]/u)[0] ?? '';
  const cleaned = firstLine.replace(CONTROL_SEQUENCES, ' ').replace(/\s+/gu, ' ').trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > MAX_VERSION_LENGTH ? `${cleaned.slice(0, MAX_VERSION_LENGTH - 1)}…` : cleaned;
}

/** Tone for an Agent-Mode-only row: presence of the CLI, nothing more. */
function agentToneFor(detection: AgentDetection | undefined, installed: boolean | undefined): ProviderRowTone {
  if (detection?.availability === 'installed' || installed === true) return 'ready';
  if (detection?.availability === 'error') return 'attention';
  return 'unavailable';
}

/** Status of a Reader Chat CLI, derived from the live provider status. */
function chatProviderStatus(status: AIProviderStatus | undefined): { label: string; tone: ProviderRowTone } {
  if (status?.installed !== true) return { label: 'Not installed', tone: 'unavailable' };
  if (status.authentication === 'connected') return { label: 'Ready', tone: 'ready' };
  if (status.authentication === 'unknown') return { label: 'Sign-in status unknown', tone: 'attention' };
  if (status.authentication === 'error') return { label: 'Sign-in check failed', tone: 'attention' };
  return { label: 'Sign-in required', tone: 'attention' };
}

/**
 * Status of the loopback server row.
 *
 * It never says "sign in": a loopback server has no account. The three states
 * it can truthfully report are whether something answered on the port, whether
 * that something has models, and whether it is usable.
 */
function localProviderStatus(status: AIProviderStatus | undefined): { label: string; tone: ProviderRowTone } {
  if (status === undefined) return { label: 'Checking…', tone: 'unavailable' };
  if (!status.installed) return { label: 'Not reachable', tone: 'unavailable' };
  if (status.models.length === 0) return { label: 'No models', tone: 'attention' };
  return { label: 'Ready', tone: 'ready' };
}

/** Absent rather than broken: a detection error still needs attention in the list. */
function agentNotInstalled(detection: ProfileDetection['detection'] | undefined, status: AIProviderStatus | undefined): boolean {
  if (detection?.availability === 'installed' || status?.installed === true) return false;
  return detection?.availability !== 'error';
}

function agentRow(
  definition: (typeof PROFILE_EDITOR_DEFINITIONS)[number],
  providers: readonly AIProviderStatus[],
  profiles: readonly ProfileDetection[]
): ProviderRow {
  const detection = profiles.find((profile) => profile.id === definition.id)?.detection;
  const chatProviderId = CHAT_PROVIDER_BY_PROFILE[definition.id];
  const status = providers.find((provider) => provider.id === chatProviderId);
  const readerChat = chatProviderId !== undefined;
  const derived = readerChat
    ? chatProviderStatus(status)
    : { label: AGENT_ONLY_LABEL, tone: agentToneFor(detection, status?.installed) };
  return {
    id: definition.id,
    name: definition.name,
    description: PROFILE_DESCRIPTIONS[definition.id] ?? '',
    version: sanitizeProviderVersion(status?.version ?? detection?.version),
    statusLabel: derived.label,
    tone: derived.tone,
    kind: 'agent',
    readerChat,
    notInstalled: agentNotInstalled(detection, status),
  };
}

/**
 * The provider accordion list: Ready providers first, then the rest, each group
 * in design order — the API provider, then every built-in agent integration
 * whether or not its CLI is installed.
 * Nothing here is sampled from the mockup — versions, availability and
 * authentication all come from main-owned detection.
 */
export function deriveProviderRows(input: {
  readonly providers: readonly AIProviderStatus[];
  readonly profiles: readonly ProfileDetection[];
  readonly openRouterCredential: OpenRouterCredentialState;
}): readonly ProviderRow[] {
  const openRouterStatus = OPENROUTER_ROW_STATUS[input.openRouterCredential];
  const openRouter: ProviderRow = {
    id: 'openrouter',
    name: 'OpenRouter API',
    description: OPENROUTER_DESCRIPTION,
    version: null,
    statusLabel: openRouterStatus.label,
    tone: openRouterStatus.tone,
    kind: 'openrouter',
    readerChat: true,
    notInstalled: false,
  };
  const ompStatus = input.providers.find((provider) => provider.id === 'omp');
  const ompDerived = chatProviderStatus(ompStatus);
  const omp: ProviderRow = {
    id: 'omp',
    name: 'Omp',
    description: OMP_DESCRIPTION,
    version: sanitizeProviderVersion(ompStatus?.version),
    statusLabel: ompDerived.label,
    tone: ompDerived.tone,
    kind: 'chat-cli',
    readerChat: true,
    notInstalled: ompStatus?.installed !== true,
  };
  const localStatus = input.providers.find((provider) => provider.id === 'local');
  const localDerived = localProviderStatus(localStatus);
  const local: ProviderRow = {
    id: 'local',
    name: 'Local server (loopback)',
    description: LOCAL_DESCRIPTION,
    version: null,
    statusLabel: localDerived.label,
    tone: localDerived.tone,
    kind: 'local',
    readerChat: true,
    notInstalled: false,
  };
  return readyFirst([
    openRouter,
    local,
    ...PROFILE_EDITOR_DEFINITIONS.map((definition) => agentRow(definition, input.providers, input.profiles)),
    omp,
  ]);
}

/** A row that can answer Reader Chat right now, i.e. one labelled Ready. */
function isReadyRow(row: ProviderRow): boolean {
  return row.readerChat && row.tone === 'ready';
}

/**
 * Ready providers lead the list so the ones a reader can use are the first
 * they see; everything else follows. Each group keeps design order.
 */
function readyFirst(rows: readonly ProviderRow[]): readonly ProviderRow[] {
  return [...rows.filter(isReadyRow), ...rows.filter((row) => !isReadyRow(row))];
}

/** Row list shown before the first status load resolves. */
export function loadingProviderRows(): readonly ProviderRow[] {
  return deriveProviderRows({ providers: [], profiles: [], openRouterCredential: 'absent' }).map((row) => ({
    ...row,
    version: null,
    statusLabel: 'Checking…',
    tone: 'unavailable' as const,
    notInstalled: false,
  }));
}

/**
 * Settings shows usable and needs-attention providers in the list itself and
 * gathers absent integrations into one collapsed group, so the list leads with
 * what a reader can act on. Each group keeps the order it was given.
 */
export function groupProviderRows(rows: readonly ProviderRow[]): {
  readonly present: readonly ProviderRow[];
  readonly notInstalled: readonly ProviderRow[];
} {
  return { present: rows.filter((row) => !row.notInstalled), notInstalled: rows.filter((row) => row.notInstalled) };
}
