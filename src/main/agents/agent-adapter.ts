import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent, AgentProfile, AgentResumeRequest, AgentRunRequest } from '@shared/types/agent';
import type { ResolvedAgentExecutionMode } from '@shared/constants/agent-modes';
import type { CustomAgentProfileConfig } from '@shared/schemas/custom-agent-profile';
import { buildMinimalChildEnvironment, execFileBounded, ProcessRunner, type ProcessLauncher, type ProcessRunHandle } from './process-runner';
import { buildCliSearchPath } from '../app/cli-search-path';
import { mapProcessEvents } from './process-event-mapping';
import { translatePiProcessEvents } from './pi-stream';
import type { MainAgentDetection, MainAgentProfile } from './profile-types';
import { BUILT_IN_AGENT_PROFILE_IDS, type AppSettings } from '@shared/schemas/settings';
import { InterleafError } from '@shared/errors/interleaf-error';
import { ExecutableRegistry, isContainedExecutablePath, validateShellExecutable } from './executable-registry';
import { assertPromptStorageAvailable, cleanupStalePromptFiles } from './custom-prompt-storage';
import { isAgentModelIdentifier } from '@shared/constants/agent-models';
import type { AgentModelDiscoverer } from './model-discovery';
import type { PortableRecord } from '@shared/models/portable';
import { expandCustomArgvTemplate } from './custom-argv-template';


export { mapProcessEvents };

/**
 * Main-owned repository trust decision. This is intentionally not part of a
 * shared/renderer request: only AgentService may attach it after resolving and
 * revalidating the target environment.
 */
export type CodexRepositoryTrust = 'trusted' | 'untrusted';

const RESERVED_REPOSITORY_BYPASS_FLAGS = new Set([
  '--skip-git-repo-check',
]);

function assertNoReservedRepositoryBypass(args: readonly string[]): void {
  if (args.some((argument) => RESERVED_REPOSITORY_BYPASS_FLAGS.has(argument.toLowerCase()))) {
    throw new InterleafError('validation', 'The Codex repository-check bypass is controlled by Interleaf execution mode.');
  }
}

/**
 * The main service owns this value, but the adapter still refuses anything it
 * does not recognise: only the exact restricted sandbox overrides are allowed
 * through, so no caller can widen a resume into `danger-full-access` or smuggle
 * an unrelated config override in.
 */
const ALLOWED_RESUME_SANDBOX_ARGS: readonly (readonly string[])[] = [
  ['-c', 'sandbox_mode="workspace-write"'],
  ['-c', 'sandbox_mode="read-only"'],
];

function assertAllowedResumeSandboxArgs(args: readonly string[]): readonly string[] {
  if (args.length === 0) return [];
  const allowed = ALLOWED_RESUME_SANDBOX_ARGS.some(
    (candidate) => candidate.length === args.length && candidate.every((token, index) => token === args[index]),
  );
  if (!allowed) {
    throw new InterleafError('security-violation', 'The requested resume sandbox arguments are not an approved native sandbox contract.');
  }
  return args;
}

export type AgentAdapterExecutionRequest = {
  readonly canonicalWorkingDirectory: string;
  readonly sessionId?: string;
  /** Set only by the main service after target/environment revalidation. */
  readonly codexRepositoryTrust?: CodexRepositoryTrust;
};

export type AgentAdapterResumeRequest = {
  readonly canonicalWorkingDirectory: string;
  readonly executionMode?: ResolvedAgentExecutionMode;
  readonly model?: string | null;
  readonly reasoningEffort?: string | null;
  readonly sessionId?: string;
  /**
   * Exact native-sandbox argv tokens from the session's persisted authority
   * snapshot. Set only by the main service, only after the native capability
   * has been re-proved against the same executable fingerprint and argv
   * contract the session started under. Empty for every other mode.
   */
  readonly sandboxArgs?: readonly string[];
  /** Set only by the main service after persisted-mode revalidation. */
  readonly codexRepositoryTrust?: CodexRepositoryTrust;
};

/** The run fields a custom command (normal or expert-shell) actually consumes. */
type CustomRunRequest = {
  readonly prompt: string;
  readonly model?: string | null;
  readonly canonicalWorkingDirectory: string;
  readonly sessionId?: string;
};

export type AgentAdapter = {
  readonly profile: MainAgentProfile;
  detect(): Promise<MainAgentDetection>;
  readonly capabilities: MainAgentProfile['capabilities'];
  start(request: AgentRunRequest & AgentAdapterExecutionRequest): AgentAdapterRun;
  cancel(): void;
  resume?(sessionId: string, request: (AgentResumeRequest | AgentRunRequest) & AgentAdapterResumeRequest): AgentAdapterRun;
};

export type AgentAdapterRun = {
  readonly events: AsyncIterable<AgentEvent>;
  readonly completion: Promise<void>;
  cancel(): void;
};

export type AgentRegistryOptions = {
  readonly processRunner?: ProcessLauncher;
  readonly now?: () => Date;
  /** Test-owned fixture behavior. Production fake execution remains prompt-inert. */
  readonly fakeFixtureBehavior?: { readonly sleep?: boolean; readonly resumeSleep?: boolean };
  readonly executableRegistry: ExecutableRegistry;
  readonly promptRoot: string;
  readonly logger: { warn(message: string, context?: PortableRecord): void };
  /** `undefined` means no CLI is ever probed for a model list. */
  readonly modelDiscovery: AgentModelDiscoverer | undefined;
};

/**
 * Item O: the only reasoning-effort forms this repository has evidence for
 * (`docs/CLI_CAPABILITIES.md`).
 *
 * Codex is deliberately absent. What is evidenced there is the *generic*
 * `-c key=value` override — that Codex accepts tokenized config overrides at
 * all — not that `model_reasoning_effort` is the key it reads for effort. An
 * unverified key is not a contract: Codex would accept the argument and run at
 * its own default while the UI showed the effort the user picked, which is the
 * exact silent mismatch this table exists to prevent. Until the key itself is
 * evidenced, a non-default Codex effort is refused rather than guessed at.
 */
const REASONING_EFFORT_ARGV: Partial<Record<AgentProfile['providerId'], (effort: string) => readonly string[]>> = {
  'claude-code': (effort) => ['--effort', effort],
  antigravity: (effort) => ['--effort', effort],
  opencode: (effort) => ['--variant', effort],
  pi: (effort) => ['--thinking', assertPiThinkingLevel(effort)],
};

/**
 * The thinking levels Pi's own argument parser accepts (`--thinking <level>`;
 * `off, minimal, low, medium, high, xhigh, max`). Interleaf's effort enum is a
 * subset of these today, but Pi treats an unrecognised level as a *warning* and
 * then runs at its default — the silent mismatch this file exists to prevent —
 * so the value is checked here rather than assumed.
 */
const PI_THINKING_LEVELS: ReadonlySet<string> = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function assertPiThinkingLevel(effort: string): string {
  if (!PI_THINKING_LEVELS.has(effort)) {
    throw new InterleafError('validation', 'Pi does not accept the selected reasoning effort as a thinking level.');
  }
  return effort;
}

/**
 * A provider with no proven effort contract refuses the run. Falling through
 * silently — which is what this did — ran the agent at whatever effort the CLI
 * defaults to, while the UI still showed the effort the user picked.
 */
function reasoningEffortArgs(profile: MainAgentProfile, effort: string): readonly string[] {
  const build = profile.capabilities.reasoningSelection ? REASONING_EFFORT_ARGV[profile.providerId] : undefined;
  if (build === undefined) {
    throw new InterleafError('validation', `${profile.name} has no verified reasoning-effort contract, so the selected effort cannot be applied.`);
  }
  return build(effort);
}

/**
 * Pi's unattended Agent Mode argv, in the order Pi's own parser reads it.
 *
 * This is the whole argv for a Pi run, not a set of tokens that must be present
 * somewhere in one. Checking presence was not enough, and the installed Pi
 * 0.84.4 parser says why: every one of these passes a presence check while
 * changing what Pi actually does.
 *
 *   * `preset + --mode text` parses to `mode: "text"` — the last `--mode` wins,
 *     so the NDJSON event stream this integration is built on disappears.
 *   * `preset + --extension ./payload.ts` parses to `noExtensions: true` *and*
 *     `extensions: ["./payload.ts"]`, and Pi's resource loader runs an
 *     explicitly named extension even when `noExtensions` is set
 *     (`dist/core/resource-loader.js:316-319`). On a CLI with no sandbox, that
 *     is arbitrary code chosen by settings.
 *   * `preset + --print @/etc/passwd` parses to `fileArgs: ["/etc/passwd"]` — a
 *     file include, defeating the stdin-only prompt boundary — and the first
 *     `--print` successor is still the innocuous `--mode`, so inspecting only
 *     that one missed it.
 *   * A bare positional parses into `messages`, becoming a second prompt.
 *
 * So the contract is exact: Interleaf owns Pi's argv, settings cannot vary it,
 * and the only tokens allowed after it are the app-owned, separately validated
 * `--model` and `--thinking` selections. Anything else fails the run closed
 * rather than launching a materially different, less contained one.
 */
const PI_ARGV_PRESET: readonly string[] = [
  '--print', '--mode', 'json',
  '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
  '--no-session', '--no-approve', '--offline',
];

/**
 * The only options Interleaf itself appends after the preset. Both carry a
 * value the app chose and already validated — a model identifier that cannot
 * begin with `-` or `@` (`AGENT_MODEL_ID_PATTERN`) and a thinking level from
 * Pi's own accepted set — so neither can become a flag, a positional, or a file
 * include in Pi's parser.
 */
const PI_APP_OWNED_FLAGS: ReadonlyMap<string, (value: string) => boolean> = new Map([
  ['--model', isAgentModelIdentifier],
  ['--thinking', (value: string) => PI_THINKING_LEVELS.has(value)],
]);

/**
 * Validate both the *stored* argv — `profile.defaultArgs`, which is where a
 * settings apply lands — and the *effective* argv the spawn will use.
 *
 * Both, because shape is not authority. The effective check can see that a
 * trailing `--model <id>` pair is well formed, but not *who put it there*. The
 * app appends a model only when `request.model ?? profile.defaultModel` is
 * non-null, so with both null a stored `[...preset, '--model', 'other/provider']`
 * reached Pi unchanged and passed as "app-owned", while `AgentService` validated
 * and recorded the null effective model: the task and document context would
 * have gone to a remote model the app never selected and never recorded,
 * outside its allowlist. The same hole let a stored `--thinking high` override
 * an unset effort.
 *
 * So the stored argv must be the preset and nothing else, and the effective
 * argv must be that preset followed only by tokens this adapter itself just
 * appended — which is what the trailing check below then re-validates.
 */
function assertPiUnattendedArgv(stored: readonly string[], args: readonly string[]): void {
  const canonical = stored.length === PI_ARGV_PRESET.length
    && PI_ARGV_PRESET.length <= args.length
    && PI_ARGV_PRESET.every((token, index) => stored[index] === token && args[index] === token);
  if (!canonical) {
    throw new InterleafError('validation', 'Pi\'s unattended arguments are owned by Interleaf and cannot be replaced or extended in settings.');
  }
  const trailing = args.slice(PI_ARGV_PRESET.length);
  const seen = new Set<string>();
  for (let index = 0; index < trailing.length; index += 2) {
    const flag = trailing[index] ?? '';
    const value = trailing[index + 1];
    const accepts = PI_APP_OWNED_FLAGS.get(flag);
    if (accepts === undefined || seen.has(flag) || value === undefined || !accepts(value)) {
      throw new InterleafError('validation', 'Pi is refused for unattended Agent Mode with arguments outside its verified contract.');
    }
    seen.add(flag);
  }
}

/**
 * Providers whose every run is dangerous by construction, whatever permission
 * mode a profile carries.
 *
 * Pi is the case this exists for: it ships no sandbox and no approval system
 * at all (its own README: "No permission popups"), so a tool-enabled Pi run has
 * unmediated access to the working copy the moment it starts. Marking the
 * profile unsafe is not a label — it routes the run through the same
 * critical-risk path as an expert shell: a fresh native confirmation on every
 * start, a dangerous-profile environment, and refusal of the Native Restricted
 * mode it cannot honour. Presenting Pi as approval-respecting would be the lie
 * this set prevents.
 */
export const ALWAYS_UNSAFE_AGENT_PROVIDERS: ReadonlySet<string> = new Set(['pi']);

const AGENT_CAPABILITIES = {
  codex: {
    structuredOutput: true, sessionResume: true, nativeSandbox: true, workingDirectory: true,
    // Effort selection is withdrawn, not merely unmapped: the capability is
    // what the UI offers, and offering a selector whose value cannot be
    // delivered is the mismatch itself.
    modelSelection: true, reasoningSelection: false, fileChangeEvents: true, toolEvents: true,
    subagents: true, interactiveAuthentication: true, nonInteractiveMode: true,
  },
  'claude-code': {
    structuredOutput: true, sessionResume: false, nativeSandbox: false, workingDirectory: true,
    modelSelection: true, reasoningSelection: true, fileChangeEvents: true, toolEvents: true,
    subagents: true, interactiveAuthentication: true, nonInteractiveMode: true,
  },
  antigravity: {
    structuredOutput: true, sessionResume: false, nativeSandbox: true, workingDirectory: true,
    modelSelection: true, reasoningSelection: true, fileChangeEvents: true, toolEvents: true,
    subagents: false, interactiveAuthentication: true, nonInteractiveMode: true,
  },
  opencode: {
    structuredOutput: true, sessionResume: false, nativeSandbox: false, workingDirectory: true,
    modelSelection: true, reasoningSelection: true, fileChangeEvents: true, toolEvents: true,
    subagents: true, interactiveAuthentication: false, nonInteractiveMode: true,
  },
  // Verified against the installed Pi 0.84.4 sources (see `docs/CLI_CAPABILITIES.md`
  // §5.1). `--print --mode json` is a real unattended mode that emits an NDJSON
  // event stream and never prompts, and `--thinking` takes exactly the levels
  // Interleaf's effort enum uses. What is NOT claimed: Pi has no sandbox and no
  // approval system of any kind, so `nativeSandbox` stays false and the profile
  // is permanently unsafe (`ALWAYS_UNSAFE_AGENT_PROVIDERS`). Its JSON events
  // carry no changed-files discriminator, so `fileChangeEvents` stays false, and
  // `--resume` was not wired, so `sessionResume` stays false. The reply, the
  // final report, and an errored or aborted turn are recovered from Pi's own
  // authoritative assistant message by `pi-stream.ts`, not from a discriminator
  // Pi does not send.
  pi: {
    structuredOutput: true, sessionResume: false, nativeSandbox: false, workingDirectory: true,
    modelSelection: true, reasoningSelection: true, fileChangeEvents: false, toolEvents: true,
    subagents: false, interactiveAuthentication: false, nonInteractiveMode: true,
  },
  // Derived from Cursor's published CLI documentation and NOT verified against
  // an installed binary: `cursor-agent` is not present in the environment this
  // profile was written in. Every capability that would require observing the
  // CLI's own behaviour is therefore false. `--resume` and a documented event
  // stream exist on paper, but neither the resume wiring nor the event
  // vocabulary has been seen, so `sessionResume`, `toolEvents` and
  // `fileChangeEvents` stay off until someone probes the real binary.
  cursor: {
    structuredOutput: true, sessionResume: false, nativeSandbox: false, workingDirectory: true,
    modelSelection: true, reasoningSelection: false, fileChangeEvents: false, toolEvents: false,
    subagents: false, interactiveAuthentication: true, nonInteractiveMode: true,
  },
  // Test/development seam only (gated by AgentService.isFakeAllowed).
  // `modelSelection` is enabled so the deterministic fixture can prove the
  // renderer→main→argv model path without invoking a paid provider.
  fake: {
    structuredOutput: true, sessionResume: true, nativeSandbox: true, workingDirectory: true,
    modelSelection: true, reasoningSelection: false, fileChangeEvents: true, toolEvents: true,
    subagents: false, interactiveAuthentication: false, nonInteractiveMode: true,
  },
} as const;

type AgentDefinition = {
  readonly id: AgentProfile['providerId'];
  readonly name: string;
  readonly binary: string;
  readonly args: readonly string[];
  readonly permissionMode: string;
  readonly capabilities: AgentProfile['capabilities'];
};

const DEFINITIONS: readonly AgentDefinition[] = [
  { id: 'codex', name: 'Codex', binary: 'codex', args: ['exec', '--json', '--sandbox', 'workspace-write'], permissionMode: 'workspace-write', capabilities: AGENT_CAPABILITIES.codex },
  { id: 'claude-code', name: 'Claude Code', binary: 'claude', args: ['--print', '--output-format', 'stream-json', '--verbose'], permissionMode: 'normal', capabilities: AGENT_CAPABILITIES['claude-code'] },
  { id: 'antigravity', name: 'Antigravity', binary: 'agy', args: ['--print', '--output-format', 'stream-json'], permissionMode: 'normal', capabilities: AGENT_CAPABILITIES.antigravity },
  { id: 'opencode', name: 'OpenCode', binary: 'opencode', args: ['run', '--format', 'json'], permissionMode: 'normal', capabilities: AGENT_CAPABILITIES.opencode },
  // Pi's unattended contract, read off the installed 0.84.4 parser and print
  // mode rather than inferred from help text. `--print --mode json` is the
  // non-interactive NDJSON mode; the four `--no-*` resource flags plus
  // `--no-session` stop Pi from loading anything the untrusted workspace could
  // supply (extensions, skills, prompt templates, themes, context files) or
  // from writing a session store; `--no-approve` pins project trust to "no" for
  // the run instead of consulting or extending a stored decision; `--offline`
  // suppresses startup network operations. This argv is the whole contract —
  // `assertPiUnattendedArgv` admits nothing else — and the prompt travels on
  // stdin, never argv.
  { id: 'pi', name: 'Pi', binary: 'pi', args: [...PI_ARGV_PRESET], permissionMode: 'unsafe-yolo', capabilities: AGENT_CAPABILITIES.pi },
  // `--print --output-format stream-json` is taken from Cursor's published CLI
  // documentation and has NOT been verified against an installed binary. The
  // documented `--force` approval bypass is deliberately excluded: this preset
  // is the approval-respecting one, and no unsafe preset is offered.
  { id: 'cursor', name: 'Cursor', binary: 'cursor-agent', args: ['--print', '--output-format', 'stream-json'], permissionMode: 'normal', capabilities: AGENT_CAPABILITIES.cursor },
];

export class AgentRegistry {
  private readonly runner: ProcessLauncher;
  private readonly now: () => Date;
  private readonly fakeFixtureBehavior: AgentRegistryOptions['fakeFixtureBehavior'];
  private readonly executableRegistry: ExecutableRegistry;
  private readonly promptRoot: string;
  private readonly logger: AgentRegistryOptions['logger'];
  private readonly modelDiscovery: AgentModelDiscoverer | undefined;
  private adapters = new Map<string, AgentAdapter>();

  constructor(options: AgentRegistryOptions) {
    this.modelDiscovery = options.modelDiscovery;
    this.runner = options.processRunner ?? new ProcessRunner();
    this.now = options.now ?? (() => new Date());
    this.fakeFixtureBehavior = options.fakeFixtureBehavior;
    this.executableRegistry = options.executableRegistry;
    this.promptRoot = options.promptRoot;
    this.logger = options.logger;
    cleanupStalePromptFiles(this.promptRoot, options.logger);
  }

  async detect(): Promise<readonly MainAgentProfile[]> {
    const detected: MainAgentProfile[] = [];
    for (const definition of DEFINITIONS) {
      const profile = await detectDefinition(definition, this.now);
      detected.push(profile);
      this.registerAdapter(new CliAgentAdapter(profile, this.runner, this.executableRegistry, this.promptRoot, this.logger));
    }
    return detected;
  }

  addFakeAdapter(): MainAgentProfile {
    const profile: MainAgentProfile = {
      id: 'fake', providerId: 'fake', name: 'Fake Agent (test/development only)', binaryPath: 'interleaf-fake',
      defaultArgs: [], defaultModel: null, reasoningEffort: null, permissionMode: 'fixture', defaultSandboxMode: 'auto-isolated',
      capabilities: AGENT_CAPABILITIES.fake, detection: { availability: 'installed', binaryPath: 'interleaf-fake', version: 'fixture', checkedAt: this.now().toISOString(), errorMessage: null },
      isCustom: false, unsafe: false,
    };
    const fixture = join(process.cwd(), 'tests', 'fixtures', 'fake-agent-cli.mjs');
    if (!existsSync(fixture)) throw new Error('Fake agent fixture is missing; refusing an in-memory runtime fallback.');
    this.registerAdapter(new FakeProcessAgentAdapter(profile, this.runner, fixture, this.fakeFixtureBehavior));
    return profile;
  }

  getAdapter(profileId: string): AgentAdapter | undefined { return this.adapters.get(profileId); }

  /**
   * Puts an adapter under its own profile's id, replacing whatever stood there.
   * Detection, the fixture profile, a settings apply, a model refresh and a
   * custom profile all register through here.
   *
   * It stays non-public: which adapter answers for a profile id is a main-owned
   * decision, and a public mutator would let any holder of the registry swap a
   * detected CLI for something else. A test that needs an adapter bound to its
   * own process launcher extends the registry instead (`tests/helpers/agent-registry.ts`).
   */
  protected registerAdapter(adapter: AgentAdapter): void {
    this.adapters.set(adapter.profile.id, adapter);
  }

  /** Apply only validated preferences to already detected main-owned adapters.
   * Binary paths remain the detected values; renderer settings can select a
   * known argv preset/model/policy but can never introduce an executable. */
  applyProfileSettings(settings: AppSettings['agent']['profiles']): void {
    for (const [profileId, preference] of Object.entries(settings)) {
      const adapter = this.adapters.get(profileId);
      if (!adapter || !BUILT_IN_AGENT_PROFILE_IDS.some((id) => id === profileId) || adapter.profile.isCustom || adapter.profile.providerId === 'custom' || adapter.profile.providerId === 'fake') continue;
      assertNoReservedRepositoryBypass(preference.arguments);
      const profile: MainAgentProfile = {
        ...adapter.profile,
        defaultArgs: preference.arguments,
        defaultModel: preference.defaultModel,
        configuredModels: preference.models,
        reasoningEffort: preference.reasoningEffort,
        permissionMode: preference.permissionMode,
        defaultSandboxMode: preference.sandboxMode,
        environmentOverrides: preference.environmentOverrides,
        // A settings apply rebuilds the profile, so a permanently unsafe
        // provider has to be re-asserted here too; otherwise choosing any other
        // permission mode in the UI would quietly downgrade a Pi run out of the
        // critical-risk path it must stay on.
        unsafe: preference.permissionMode === 'unsafe-yolo' || ALWAYS_UNSAFE_AGENT_PROVIDERS.has(adapter.profile.providerId),
      };
      this.registerAdapter(new CliAgentAdapter(profile, this.runner, this.executableRegistry, this.promptRoot, this.logger));
    }
  }

  listMainProfiles(): readonly MainAgentProfile[] {
    return [...this.adapters.values()].map((adapter) => adapter.profile);
  }

  /**
   * Ask each installed built-in CLI which models it accepts, and attach the
   * answer to the adapter's main-owned profile.
   *
   * This is the only way a model identifier enters the runtime without a user
   * typing it, so it stays narrow: built-in detected CLIs only, never a custom
   * executable or the fixture, never a provider without a real listing
   * mechanism, and never a profile whose adapter says it has no model
   * selection. A provider that does not answer is simply left as it was.
   *
   * Returns whether any profile's list actually changed.
   */
  async refreshDiscoveredModels(force = false): Promise<boolean> {
    const discovery = this.modelDiscovery;
    if (discovery === undefined) return false;
    let changed = false;
    for (const profileId of [...this.adapters.keys()]) {
      const profile = this.adapters.get(profileId)?.profile;
      if (profile === undefined) continue;
      if (profile.isCustom || profile.providerId === 'custom' || profile.providerId === 'fake') continue;
      if (profile.detection.availability !== 'installed' || !profile.capabilities.modelSelection) continue;
      if (!discovery.supports(profile.providerId)) continue;
      const catalog = await discovery.discover(profile.providerId, profile.binaryPath, force);
      // The adapter may have been replaced by a settings apply while the probe
      // ran; always attach to whatever profile is current, never to the
      // snapshot this loop started from.
      const latest = this.adapters.get(profileId)?.profile;
      if (catalog === null || latest === undefined) continue;
      const previous = latest.discoveredModels ?? [];
      if (previous.length === catalog.models.length && previous.every((model, index) => model === catalog.models[index])) continue;
      this.registerAdapter(new CliAgentAdapter({ ...latest, discoveredModels: catalog.models }, this.runner, this.executableRegistry, this.promptRoot, this.logger));
      changed = true;
    }
    return changed;
  }

  /**
   * Stop model listing and wait for the probe children it owns. Shutdown calls
   * this so a listing CLI cannot outlive the service that started it.
   */
  async closeModelDiscovery(): Promise<void> {
    await this.modelDiscovery?.close();
  }

  addCustomProfile(input: {
    readonly id: string;
    readonly name: string;
    readonly binaryPath: string;
    readonly executableHandle: string;
    readonly executableIdentity: MainAgentProfile['executableIdentity'];
    readonly config: CustomAgentProfileConfig;
  }): MainAgentProfile {
    if (input.executableIdentity === undefined) throw new InterleafError('internal', 'Custom executable capabilities are unavailable.');
    const id = input.id;
    const profile: MainAgentProfile = {
      id,
      providerId: 'custom',
      name: input.name,
      binaryPath: input.binaryPath,
      defaultArgs: input.config.executionKind === 'expert-shell' ? [] : input.config.argvTemplate,
      defaultModel: input.config.defaultModel ?? null,
      reasoningEffort: input.config.reasoningEffort ?? null,
      permissionMode: 'custom',
      defaultSandboxMode: input.config.defaultSandboxMode,
      capabilities: {
        structuredOutput: input.config.stdoutParsingMode === 'json-lines',
        sessionResume: input.config.supportsResume,
        nativeSandbox: false,
        workingDirectory: true,
        modelSelection: input.config.supportsModelSelection,
        reasoningSelection: input.config.supportsReasoningSelection,
        fileChangeEvents: false,
        toolEvents: false,
        subagents: false,
        interactiveAuthentication: false,
        nonInteractiveMode: true,
      },
      detection: { availability: 'installed', binaryPath: null, version: null, checkedAt: new Date().toISOString(), errorMessage: null },
      isCustom: true,
      // A renderer-created executable and argv are always unverified. The
      // persisted unsafe flag can only add warnings; it can never make this
      // runtime look safe to mode resolution.
      unsafe: true,
      environmentOverrides: input.config.environmentOverrides,
      workingDirectoryPolicy: input.config.workingDirectoryPolicy,
      executableHandle: input.executableHandle,
      executableIdentity: input.executableIdentity,
      customConfig: input.config,
      promptRoot: this.promptRoot,
    };
    assertNoReservedRepositoryBypass(profile.defaultArgs);
    if (profile.customConfig?.executionKind === 'normal') {
      assertNoReservedRepositoryBypass(profile.customConfig.argvTemplate);
      if (profile.customConfig.resumeCommandTemplate !== null) {
        assertNoReservedRepositoryBypass(profile.customConfig.resumeCommandTemplate);
      }
    }
    this.registerAdapter(new CliAgentAdapter(profile, this.runner, this.executableRegistry, this.promptRoot, this.logger));
    return profile;
  }

  addUnavailableCustomProfile(input: {
    readonly id: string;
    readonly name: string;
    readonly binaryPath: string;
    readonly executableIdentity: MainAgentProfile['executableIdentity'];
    readonly config: CustomAgentProfileConfig;
    readonly errorMessage: string;
  }): MainAgentProfile {
    const profile = this.addCustomProfile({
      id: input.id,
      name: input.name,
      binaryPath: input.binaryPath,
      executableHandle: `unavailable-${input.id.slice(-36)}`,
      executableIdentity: input.executableIdentity,
      config: input.config,
    });
    const unavailable: MainAgentProfile = { ...profile, detection: { ...profile.detection, availability: 'error', errorMessage: input.errorMessage } };
    this.registerAdapter(new CliAgentAdapter(unavailable, this.runner, this.executableRegistry, this.promptRoot, this.logger));
    return unavailable;
  }

  removeProfile(profileId: string): void {
    if (profileId === 'codex' || profileId === 'claude-code' || profileId === 'antigravity' || profileId === 'copilot' || profileId === 'opencode' || profileId === 'pi' || profileId === 'cursor' || profileId === 'fake') return;
    this.adapters.delete(profileId);
  }
}

export class CliAgentAdapter implements AgentAdapter {
  constructor(
    public readonly profile: MainAgentProfile,
    private readonly runner: ProcessLauncher,
    private readonly executableRegistry: ExecutableRegistry,
    private readonly promptRoot: string,
    private readonly logger: AgentRegistryOptions['logger'],
  ) {}

  private readonly runs = new Set<ProcessRunHandle>();
  get capabilities(): MainAgentProfile['capabilities'] { return this.profile.capabilities; }

  detect(): Promise<MainAgentDetection> { return Promise.resolve(this.profile.detection); }

  start(request: AgentRunRequest & AgentAdapterExecutionRequest): AgentAdapterRun {
    // Copilot is no longer a built-in definition, but `copilot` stays a legacy
    // provider id in persisted data; refuse it here as defence in depth.
    if (this.profile.providerId === 'copilot') {
      throw new InterleafError('validation', 'GitHub Copilot CLI is unavailable for unattended Agent Mode.');
    }
    if (!this.profile.capabilities.nonInteractiveMode) {
      throw new InterleafError('validation', `${this.profile.name} is unavailable for unattended Agent Mode.`);
    }
    if (this.profile.providerId === 'custom') {
      if (this.profile.customConfig?.executionKind === 'expert-shell' && typeof this.profile.customConfig.shellCommand === 'string') {
        return this.startCustomExpertShell(request, this.profile.customConfig.shellCommand, request.sessionId ?? 'run');
      }
      const argvTemplate = (this.profile.customConfig?.executionKind === 'normal'
        ? this.profile.customConfig.argvTemplate
        : undefined) ?? this.profile.defaultArgs;
      return this.startCustom(request, argvTemplate, request.sessionId ?? 'run');
    }
    const args = [...this.profile.defaultArgs];
    assertNoReservedRepositoryBypass(args);
    if (this.profile.providerId === 'codex' && request.codexRepositoryTrust === 'untrusted') {
      args.push('--skip-git-repo-check');
    }
    const effectiveModel = request.model ?? this.profile.defaultModel;
    if (this.profile.capabilities.modelSelection && typeof effectiveModel === 'string' && effectiveModel.trim().length > 0) {
      const model = effectiveModel.trim();
      if (Buffer.byteLength(model, 'utf8') > 128) {
        throw new InterleafError('validation', 'The selected agent model exceeds the bounded runtime limit.');
      }
      if (!isAgentModelIdentifier(model)) {
        throw new InterleafError('validation', 'The selected agent model is not a valid identifier.');
      }
      // Profile settings may carry a provider preset, but the effective model
      // is still represented by exactly one argv option in built-in adapters.
      const modelArgs: string[] = [];
      for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === undefined) continue;
        if (argument === '--model') {
          index += 1;
          continue;
        }
        modelArgs.push(argument);
      }
      args.length = 0;
      args.push(...modelArgs, '--model', model);
    }
    if (this.profile.reasoningEffort !== null) {
      args.push(...reasoningEffortArgs(this.profile, this.profile.reasoningEffort));
    }
    // Only providers with an explicit stdin contract receive the bounded
    // prompt through stdin. Other built-ins receive one opaque argv value;
    // no shell expansion or string command construction is involved.
    //
    // Pi is here for a safety reason, not a stylistic one: its parser treats a
    // positional beginning with `@` as a file to include — even after `--` —
    // and `--print` swallows the token after it. A prompt that happens to start
    // with `@` or `-` would therefore change what Pi does. Pi reads a piped
    // stdin as the whole initial message, so the prompt never enters argv.
    const useStdin = this.profile.providerId === 'codex'
      || this.profile.providerId === 'claude-code'
      || this.profile.providerId === 'pi';
    if (this.profile.providerId === 'codex') args.push('-');
    else if (!useStdin) args.push(request.prompt);
    // Checked against the stored argv as well as the effective one, so a
    // settings-supplied token can never pass as one this adapter appended.
    if (this.profile.providerId === 'pi') assertPiUnattendedArgv(this.profile.defaultArgs, args);
    const environment = profileEnvironment(this.profile);
    const handle = this.runner.run({
      file: this.profile.binaryPath,
      args,
      cwd: request.canonicalWorkingDirectory,
      ...environment,
      ...(useStdin ? { stdin: request.prompt } : {}),
    });
    this.runs.add(handle);
    const stream = this.profile.providerId === 'pi' ? translatePiProcessEvents(handle.events) : handle.events;
    return { events: mapProcessEvents(stream, () => { this.runs.delete(handle); }), completion: handle.completion, cancel: () => { handle.cancel(); } };
  }

  resume(sessionId: string, request: (AgentResumeRequest | AgentRunRequest) & AgentAdapterResumeRequest): AgentAdapterRun {
    if (this.profile.providerId === 'codex') {
      const args = ['exec', 'resume', '--json'];
      // `codex exec resume` has no `--sandbox` selector; the sandbox policy is
      // carried by the same tokenized `-c key=value` override this adapter
      // already uses for reasoning effort. Without this the native-restricted
      // sandbox chosen at start would silently disappear on resume.
      args.push(...assertAllowedResumeSandboxArgs(request.sandboxArgs ?? []));
      if (request.codexRepositoryTrust === 'untrusted') {
        args.push('--skip-git-repo-check');
      }
      const effectiveModel = request.model !== undefined ? request.model : this.profile.defaultModel;
      if (typeof effectiveModel === 'string' && effectiveModel.length > 0) {
        if (!isAgentModelIdentifier(effectiveModel)) {
          throw new InterleafError('validation', 'The selected agent model is not a valid identifier.');
        }
        args.push('--model', effectiveModel);
      }
      const effectiveReasoningEffort = request.reasoningEffort !== undefined ? request.reasoningEffort : this.profile.reasoningEffort;
      if (typeof effectiveReasoningEffort === 'string' && effectiveReasoningEffort.length > 0) {
        // Item O: resume carries the same proven contract as start, because
        // `codex exec resume` has no `--effort` selector of its own.
        args.push(...reasoningEffortArgs(this.profile, effectiveReasoningEffort));
      }
      args.push(sessionId, '-');
      const environment = profileEnvironment(this.profile);
      const handle = this.runner.run({
        file: this.profile.binaryPath,
        args,
        cwd: request.canonicalWorkingDirectory,
        ...environment,
        stdin: request.prompt,
      });
      this.runs.add(handle);
      return {
        events: mapProcessEvents(handle.events, () => { this.runs.delete(handle); }),
        completion: handle.completion,
        cancel: () => { handle.cancel(); },
      };
    }
    if (this.profile.providerId === 'custom') {
      if (this.profile.customConfig?.executionKind === 'expert-shell') {
        const resumeCmd = this.profile.customConfig.resumeShellCommand;
        if (!this.profile.capabilities.sessionResume || resumeCmd === null || resumeCmd.trim().length === 0) {
          throw new InterleafError('validation', 'Session resume is not configured for this custom profile.');
        }
        return this.startCustomExpertShell(
          {
            prompt: request.prompt,
            model: request.model ?? null,
            canonicalWorkingDirectory: request.canonicalWorkingDirectory,
            sessionId: request.sessionId ?? sessionId,
          },
          resumeCmd,
          sessionId,
          { reasoningEffort: request.reasoningEffort ?? null },
        );
      }
      const resumeTemplate = this.profile.customConfig?.executionKind === 'normal'
        ? this.profile.customConfig.resumeCommandTemplate
        : null;
      if (!this.profile.capabilities.sessionResume || resumeTemplate === null) {
        throw new InterleafError('validation', 'Session resume is not configured for this custom profile.');
      }
      return this.startCustom(
        {
          prompt: request.prompt,
          model: request.model ?? null,
          canonicalWorkingDirectory: request.canonicalWorkingDirectory,
          sessionId: request.sessionId ?? sessionId,
        },
        resumeTemplate,
        sessionId,
        { isResume: true, reasoningEffort: request.reasoningEffort ?? null },
      );
    }
    throw new InterleafError('validation', `${this.profile.name} does not support session resume.`);
  }

  private startCustom(
    request: CustomRunRequest,
    template: readonly string[],
    sessionId: string,
    options?: { readonly isResume?: boolean; readonly reasoningEffort?: string | null },
  ): AgentAdapterRun {
    const { executableHandle, executableIdentity } = this.profile;
    if (executableHandle === undefined || executableIdentity === undefined || this.profile.customConfig === undefined) {
      throw new InterleafError('security-violation', 'The custom executable capability is unavailable.');
    }
    const executable = this.executableRegistry.resolveSync(executableHandle);
    if (executable.identity.sha256 !== executableIdentity.sha256) {
      throw new InterleafError('security-violation', 'The configured executable changed and execution was stopped.');
    }
    if (this.profile.workingDirectoryPolicy !== 'select-per-run') throw new InterleafError('security-violation', 'The custom working-directory policy is unavailable.');
    if (isContainedExecutablePath(executable.canonicalPath, request.canonicalWorkingDirectory)) {
      throw new InterleafError('security-violation', 'Custom executables cannot be stored inside the prepared agent workspace.');
    }
    const config = this.profile.customConfig;
    let promptFile: string | undefined;
    if (config.promptDeliveryMode === 'temp-file') {
      if (Buffer.byteLength(request.prompt, 'utf8') > 256 * 1024) throw new InterleafError('validation', 'Agent prompt exceeds the bounded runtime limit.');
      mkdirSync(this.promptRoot, { recursive: true, mode: 0o700 });
      assertPromptStorageAvailable(this.promptRoot);
      promptFile = join(this.promptRoot, `${randomUUID()}.prompt`);
      writeFileSync(promptFile, request.prompt, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    }
    try {
      const effectiveReasoningEffort = options?.reasoningEffort !== undefined ? options.reasoningEffort : (this.profile.reasoningEffort ?? null);
      const args = expandCustomArgvTemplate(template, {
        workingDir: request.canonicalWorkingDirectory,
        promptFile: promptFile ?? '',
        sessionId,
        model: request.model ?? null,
        reasoningEffort: effectiveReasoningEffort,
      }, options?.isResume ? { isResume: true } : undefined);
      const environment = profileEnvironment(this.profile);
      const handle = this.runner.run({
        file: executable.canonicalPath,
        args,
        cwd: request.canonicalWorkingDirectory,
        ...environment,
        ...(config.promptDeliveryMode === 'stdin' ? { stdin: request.prompt } : {}),
      });
      this.runs.add(handle);
      const completion = handle.completion.finally(() => {
        this.runs.delete(handle);
        if (promptFile !== undefined) removePromptFile(promptFile, this.logger);
      });
      return {
        events: mapProcessEvents(handle.events, () => { this.runs.delete(handle); }, config.stdoutParsingMode),
        completion,
        cancel: () => { handle.cancel(); },
      };
    } catch (error) {
      // The prompt file is created before argv expansion and spawn. A test
      // seam or future runner may throw synchronously, so remove it on every
      // pre-completion failure as well as the normal completion path.
      if (promptFile !== undefined) removePromptFile(promptFile, this.logger);
      throw error;
    }
  }
  private startCustomExpertShell(
    request: CustomRunRequest,
    command: string,
    sessionId: string,
    options?: { readonly reasoningEffort?: string | null },
  ): AgentAdapterRun {
    const config = this.profile.customConfig;
    const { executableHandle, executableIdentity } = this.profile;
    if (executableHandle === undefined || executableIdentity === undefined || config?.executionKind !== 'expert-shell') {
      throw new InterleafError('security-violation', 'The custom expert shell capability is unavailable.');
    }
    const executable = this.executableRegistry.resolveSync(executableHandle);
    if (executable.identity.sha256 !== executableIdentity.sha256) {
      throw new InterleafError('security-violation', 'The configured executable changed and execution was stopped.');
    }
    if (this.profile.workingDirectoryPolicy !== 'select-per-run') {
      throw new InterleafError('security-violation', 'The custom working-directory policy is unavailable.');
    }
    if (isContainedExecutablePath(executable.canonicalPath, request.canonicalWorkingDirectory)) {
      throw new InterleafError('security-violation', 'Custom executables cannot be stored inside the prepared agent workspace.');
    }
    validateShellExecutable(executable.canonicalPath, config.shellFamily);
    let args: readonly string[];
    if (config.shellFamily === 'posix') {
      args = ['-lc', command];
    } else if (config.shellFamily === 'powershell') {
      args = ['-NoProfile', '-NonInteractive', '-Command', command];
    } else {
      args = ['/d', '/s', '/c', command];
    }

    const runId = randomUUID();
    const effectiveReasoningEffort = options?.reasoningEffort !== undefined ? options.reasoningEffort : (this.profile.reasoningEffort ?? '');
    const extraEnv: Record<string, string> = {
      INTERLEAF_SESSION_ID: sessionId,
      INTERLEAF_RUN_ID: runId,
      INTERLEAF_MODEL: request.model ?? '',
      INTERLEAF_REASONING_EFFORT: effectiveReasoningEffort ?? '',
      INTERLEAF_WORKING_DIR: request.canonicalWorkingDirectory,
    };

    const baseEnv = profileEnvironment(this.profile);
    const combinedEnv: Record<string, string> = {
      ...(baseEnv.env ?? {}),
      ...extraEnv,
    };

    const handle = this.runner.run({
      file: executable.canonicalPath,
      args: [...args],
      cwd: request.canonicalWorkingDirectory,
      env: combinedEnv,
      ...(baseEnv.clearEnv !== undefined ? { clearEnv: baseEnv.clearEnv } : {}),
      stdin: request.prompt,
    });
    this.runs.add(handle);
    const completion = handle.completion.finally(() => {
      this.runs.delete(handle);
    });
    return {
      events: mapProcessEvents(handle.events, () => { this.runs.delete(handle); }, config.stdoutParsingMode),
      completion,
      cancel: () => { handle.cancel(); },
    };
  }


  cancel(): void { for (const run of this.runs) run.cancel(); }
}

/** Deletes a run's prompt file; a failure is logged by type only, since the run's outcome stands. */
function removePromptFile(promptFile: string, logger: AgentRegistryOptions['logger']): void {
  try {
    unlinkSync(promptFile);
  } catch (cleanupError) {
    logger.warn('custom agent prompt cleanup failed', {
      errorType: cleanupError instanceof Error ? cleanupError.name : typeof cleanupError,
    });
  }
}

function profileEnvironment(profile: MainAgentProfile): {
  readonly env?: Readonly<Record<string, string>>;
  readonly clearEnv?: readonly string[];
} {
  const env: Record<string, string> = {};
  const clearEnv: string[] = [];
  const inherited = new Set(['PATH', 'HOME', 'USER', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME', 'TERM', 'SHELL', 'COMSPEC', 'PATHEXT']);
  for (const override of profile.environmentOverrides ?? []) {
    if (override.action === 'clear') {
      clearEnv.push(override.name);
      continue;
    }
    if (inherited.has(override.name.toUpperCase())) {
      // Inheriting PATH means the same usable PATH detection resolved against.
      const value = override.name === 'PATH' ? buildCliSearchPath() : process.env[override.name];
      if (value !== undefined) env[override.name] = value;
    }
  }
  return {
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(clearEnv.length > 0 ? { clearEnv } : {}),
  };
}

/**
 * Runtimes Interleaf does not offer for unattended Agent Mode at all.
 *
 * GitHub Copilot CLI is no longer registered as a built-in definition, so it
 * is never detected; its entry is kept for legacy `copilot` ids still present
 * in persisted data, so any surface classifying one reports it unsupported.
 *
 * Their `not-installed` is a fixed product decision, not a finding: detection
 * returns before any PATH lookup happens, so the executable may well be present.
 * Exported so the surfaces that explain unavailability to a user — which must
 * not send them to an install page for a runtime that would still be refused —
 * read the same decision `detectDefinition` acts on, rather than pattern-matching
 * an error string.
 */
export const FIXED_UNAVAILABLE_AGENT_PROVIDERS: ReadonlyMap<string, string> = new Map([
  ['copilot', 'GitHub Copilot CLI is unavailable for unattended Agent Mode.'],
]);

async function detectDefinition(definition: AgentDefinition, now: () => Date): Promise<MainAgentProfile> {
  const checkedAt = now().toISOString();
  const fixedUnavailability = FIXED_UNAVAILABLE_AGENT_PROVIDERS.get(definition.id);
  if (fixedUnavailability !== undefined) {
    return profileFromDefinition(definition, {
      availability: 'not-installed', binaryPath: null, version: null, checkedAt,
      errorMessage: fixedUnavailability,
    });
  }
  // Lookup and probes see the same minimal environment, and so the same PATH,
  // that the agent's own child process will be spawned with.
  const env = buildMinimalChildEnvironment();
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    const result = await execFileBounded(command, [definition.binary], { shell: false, encoding: 'utf8', env, timeout: 5_000, maxBuffer: 16 * 1024, windowsHide: true });
    const binaryPath = result.stdout.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0) ?? definition.binary;
    let version: string | null = null;
    try {
      const versionResult = await execFileBounded(binaryPath, ['--version'], { shell: false, encoding: 'utf8', env, timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true });
      version = `${versionResult.stdout}${versionResult.stderr}`.trim().slice(0, 512) || null;
    } catch {
      // --version is a bounded, read-only probe. The binary remains installed if
      // a vendor uses another version flag.
    }
    try {
      // Help is a second bounded, non-destructive reconnaissance probe. Its
      // output is intentionally not treated as a stable vendor API.
      await execFileBounded(binaryPath, ['--help'], { shell: false, encoding: 'utf8', env, timeout: 5_000, maxBuffer: 128 * 1024, windowsHide: true });
    } catch {
      // A CLI may use a different help flag; keep it visible as installed but
      // do not infer capabilities from this failed probe.
    }
    return profileFromDefinition(definition, {
      availability: 'installed', binaryPath, version, checkedAt, errorMessage: null,
    });
  } catch {
    const message = 'CLI is not installed or could not be probed.';
    return profileFromDefinition(definition, {
      availability: 'not-installed', binaryPath: null, version: null, checkedAt,
      errorMessage: message.slice(0, 2_000),
    });
  }
}

function profileFromDefinition(definition: AgentDefinition, detection: MainAgentDetection): MainAgentProfile {
  return {
    id: definition.id,
    providerId: definition.id,
    name: definition.name,
    binaryPath: detection.binaryPath ?? definition.binary,
    defaultArgs: definition.args,
    defaultModel: null,
    reasoningEffort: null,
    permissionMode: definition.permissionMode,
    defaultSandboxMode: 'auto-isolated',
    capabilities: definition.capabilities,
    detection,
    isCustom: false,
    unsafe: ALWAYS_UNSAFE_AGENT_PROVIDERS.has(definition.id)
      || definition.args.includes('--yolo')
      || definition.permissionMode.toLowerCase().includes('bypass'),
  };
}

class FakeProcessAgentAdapter implements AgentAdapter {
  constructor(public readonly profile: MainAgentProfile, private readonly runner: ProcessLauncher, private readonly fixture: string, private readonly behavior: AgentRegistryOptions['fakeFixtureBehavior']) {}
  get capabilities(): MainAgentProfile['capabilities'] { return this.profile.capabilities; }
  detect(): Promise<MainAgentDetection> { return Promise.resolve(this.profile.detection); }
  /** Mirrors the built-in CLI adapters' single `--model <value>` argv slot so
   * the fixture echoes exactly what a real launch would have received. */
  private modelFlags(model: string | null | undefined): readonly string[] {
    if (!this.profile.capabilities.modelSelection) return [];
    const effective = (model ?? '').trim();
    return effective.length === 0 ? [] : ['--model', effective];
  }

  start(request: AgentRunRequest & { readonly canonicalWorkingDirectory: string }): AgentAdapterRun {
    const flags = ['--read-stdin', '--mutate-workspace', ...this.modelFlags(request.model ?? this.profile.defaultModel)];
    if (this.behavior?.sleep === true) flags.push('--sleep', '--ignore-termination');
    // Electron's executable needs the explicit run-as-Node switch when the
    // fixture is launched from the main process; plain Node ignores it. This
    // remains a test/dev-only process and never reaches packaged builds.
    const handle = this.runner.run({ file: process.execPath, args: [this.fixture, ...flags], cwd: request.canonicalWorkingDirectory, stdin: request.prompt, env: { ELECTRON_RUN_AS_NODE: '1' } });
    return { events: mapProcessEvents(handle.events), completion: handle.completion, cancel: () => { handle.cancel(); } };
  }
  resume(sessionId: string, request: (AgentResumeRequest | AgentRunRequest) & AgentAdapterResumeRequest): AgentAdapterRun {
    // The recorded session snapshot is authoritative on resume: never fall
    // back to the profile default, which may have changed since the run began.
    const flags = ['--read-stdin', '--mutate-workspace', '--resume', sessionId, ...this.modelFlags(request.model)];
    if (this.behavior?.sleep === true || this.behavior?.resumeSleep === true) flags.push('--sleep', '--ignore-termination');
    const handle = this.runner.run({ file: process.execPath, args: [this.fixture, ...flags], cwd: request.canonicalWorkingDirectory, stdin: request.prompt, env: { ELECTRON_RUN_AS_NODE: '1' } });
    return { events: mapProcessEvents(handle.events), completion: handle.completion, cancel: () => { handle.cancel(); } };
  }
  cancel(): void { /* Each run owns its cancellation handle. */ }
}

/** Built-in detection, exported so boundary tests can probe fixture binaries
 * through the real resolver without launching whatever CLIs the host has. */
export { DEFINITIONS as BUILT_IN_AGENT_DEFINITIONS, detectDefinition as detectAgentDefinition };
