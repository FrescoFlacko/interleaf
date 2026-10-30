import { z } from 'zod';
import type { DocumentSortOption } from '../types/document';
import { PALETTE_IDS } from '../constants/palettes';
import {
  AGENT_DEFAULT_EXECUTION_MODES,
  DEFAULT_AGENT_EXECUTION_MODE,
} from '../constants/agent-modes';
import { DEFAULT_PALETTE } from '../constants/palettes';
import { aiProviderIdSchema, modelIdSchema, openRouterModelIdSchema } from './ai';
import {
  ONBOARDING_SETTINGS_VERSION,
  ONBOARDING_STAGES,
  ONBOARDING_STATUSES,
} from '../constants/onboarding';
import {
  DEFAULT_LOCAL_ENDPOINT,
  isLoopbackEndpoint,
  LOCAL_ENDPOINT_MAX_LENGTH,
  LOCAL_ENDPOINT_MODES,
  LOOPBACK_ENDPOINT_MESSAGES,
} from './local-endpoint';
import { agentProfileModelsSchema } from './agent-model';
import { customAgentProfileIdSchema } from './custom-agent-profile';

const paletteIdSchema = z.enum(PALETTE_IDS);

/** Header theme menu length: the current theme plus this many recent ones. */
export const MAX_RECENT_PALETTES = 6;

const appearanceSettingsSchema = z.object({
  palette: paletteIdSchema,
  /** Most recently used other themes, newest first; absent until a theme changes. */
  recentPalettes: z.array(paletteIdSchema).max(MAX_RECENT_PALETTES).exactOptional(),
});

/** Reader typography is intentionally bounded.  PDF adapters consume only the
 * applicable zoom/background values; reflow controls are used by EPUB/MOBI/
 * DOCX and never rewrite the source document. */
const readerSettingsSchema = z.object({
  background: z.enum(['palette', ...PALETTE_IDS]).default('palette'),
  fontSize: z.number().min(0.75).max(2).default(1),
  fontFamily: z.enum(['system', 'serif', 'sans', 'dyslexic']).default('system'),
  lineSpacing: z.number().min(1.2).max(2.2).default(1.65),
  contentWidth: z.number().min(40).max(100).default(72),
  paragraphSpacing: z.number().min(0).max(3).default(0.8),
  pageMargin: z.number().min(0.75).max(5).default(2.5),
});

/**
 * Readable-text scale for the companion column (AI Chat and Agent).
 *
 * One preference covers both tabs: they are the same column, the reader moves
 * between them with one keystroke, and a size chosen for one is the size the
 * same eyes need in the other. The bounds are narrower than the reader's own
 * font scale because the companion is a fixed-width column beside the
 * document: below 0.85 the transcript stops being readable at all, and above
 * 1.5 a prompt line no longer fits the narrowest supported panel.
 */
export const COMPANION_TEXT_SIZE_MIN = 0.85;
export const COMPANION_TEXT_SIZE_MAX = 1.5;
export const COMPANION_TEXT_SIZE_STEP = 0.05;
/** Unchanged appearance until the reader asks for something else. */
export const COMPANION_TEXT_SIZE_DEFAULT = 1;

const companionSettingsSchema = z.object({
  textSize: z.number().min(COMPANION_TEXT_SIZE_MIN).max(COMPANION_TEXT_SIZE_MAX).default(COMPANION_TEXT_SIZE_DEFAULT),
});

/**
 * Clamp and quantize a requested companion text scale to the persisted range.
 *
 * Shared by the control and the store so a value that reaches settings has
 * already been made representable; a non-finite request keeps the default
 * rather than writing `NaN` into the settings document.
 */
export function normalizeCompanionTextSize(value: number): number {
  if (!Number.isFinite(value)) return COMPANION_TEXT_SIZE_DEFAULT;
  const clamped = Math.min(COMPANION_TEXT_SIZE_MAX, Math.max(COMPANION_TEXT_SIZE_MIN, value));
  // Two decimals: binary floating point cannot hold a multiple of 0.05 exactly,
  // and an unrounded product can land a hair outside the range the schema
  // accepts, which would reject the very value the control just offered.
  return Math.round((Math.round(clamped / COMPANION_TEXT_SIZE_STEP) * COMPANION_TEXT_SIZE_STEP) * 100) / 100;
}

const layoutSettingsSchema = z.object({
  leftWidth: z.number().min(220).max(440).default(256),
  rightWidth: z.number().min(280).max(560).default(320),
  leftOpen: z.boolean().default(true),
  rightOpen: z.boolean().default(true),
  /**
   * Whether the companion drawer opens at launch. Read once, when settings
   * first hydrate; `rightOpen` only records the last live state. Defaulted to
   * open so the AI drawer is discoverable and a document written before this
   * field existed keeps every other preference.
   */
  openRightPanelOnStartup: z.boolean().default(true),
});

/** Settings preferences are only for the built-in adapters. Custom profiles
 * have a separate main-owned CRUD store and must never be addressable through
 * this renderer-persisted map. */
export const BUILT_IN_AGENT_PROFILE_IDS = ['codex', 'claude-code', 'antigravity', 'copilot', 'opencode', 'pi', 'cursor'] as const;
const BUILT_IN_AGENT_PROFILE_ID_SET = new Set<string>(BUILT_IN_AGENT_PROFILE_IDS);

/** Renderer-safe public projection of a main-owned working-directory
 * capability. Canonical paths and filesystem identities never cross IPC. */
export const MAX_SAVED_WORKING_DIRECTORIES = 32;
export const MAX_DEFAULT_WORKING_DIRECTORY_PROFILES = 64;
/**
 * Directory capabilities are represented by opaque main-issued handles. A
 * deliberately narrow token shape keeps path-like values out of settings
 * even before the main-owned registry performs identity validation.
 */
export const workingDirectoryHandleSchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u, 'Working-directory handles must be opaque tokens, not paths.');
export const workingDirectoryDisplayNameSchema = z.string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !/[\\/\u0000]/u.test(value), 'Working-directory display names must not contain path separators.');
const savedWorkingDirectorySchema = z.object({
  handle: workingDirectoryHandleSchema,
  displayName: workingDirectoryDisplayNameSchema,
}).strict();

const agentProfileKeySchema = z.union([
  z.enum(BUILT_IN_AGENT_PROFILE_IDS),
  customAgentProfileIdSchema,
]);

/**
 * Agent preferences persisted in the settings store. The execution-mode
 * default encodes the ADR-0008 safety hierarchy. Direct-workspace modes are
 * excluded here and remain explicit, grant-bound per-session choices.
 */
export const agentSettingsSchema = z.object({
  defaultExecutionMode: z.enum(AGENT_DEFAULT_EXECUTION_MODES),
  /**
   * The profile a *new* agent draft starts on, or `null` for "no preference".
   *
   * Restricted to the built-in profiles for the same reason `profiles` is: a
   * settings document must not be able to name an arbitrary user-configured
   * executable as a startup default. Preexisting custom profiles stay fully
   * usable and selectable per draft. Defaulted to `null` so a document written
   * before this field existed loads unchanged, and consumed only when a draft
   * is composed — open drafts and running sessions keep their own binding.
   */
  defaultProfileId: z.enum(BUILT_IN_AGENT_PROFILE_IDS).nullable().default(null),
  /** Default global workspace handle; revalidated in main. */
  defaultWorkingDirectory: workingDirectoryHandleSchema.nullable().default(null),
  /** Saved global capabilities; every handle is revalidated in main. */
  workingDirectories: z.array(savedWorkingDirectorySchema)
    .max(MAX_SAVED_WORKING_DIRECTORIES)
    .superRefine((entries, context) => {
      const handles = new Set<string>();
      for (const [index, entry] of entries.entries()) {
        if (handles.has(entry.handle)) {
          context.addIssue({ code: 'custom', path: [index, 'handle'], message: 'Working-directory handles must be unique.' });
        }
        handles.add(entry.handle);
      }
    })
    .default([]),
  /** Profile defaults are handles into workingDirectories, never paths. */
  defaultWorkingDirectoryByProfile: z.record(agentProfileKeySchema, workingDirectoryHandleSchema)
    .superRefine((mapping, context) => {
      if (Object.keys(mapping).length > MAX_DEFAULT_WORKING_DIRECTORY_PROFILES) {
        context.addIssue({ code: 'too_big', maximum: MAX_DEFAULT_WORKING_DIRECTORY_PROFILES, origin: 'object', inclusive: true, message: `At most ${String(MAX_DEFAULT_WORKING_DIRECTORY_PROFILES)} profile defaults may be saved.` });
      }
    })
    .default({}),
  profiles: z.record(z.string().trim().min(1).max(64), z.object({
    /** This is a known CLI id, never a user-supplied executable path. */
    binary: z.enum(['codex', 'claude', 'agy', 'copilot', 'opencode', 'pi', 'cursor-agent']),
    /** Main validates this against the selected binary's allowlisted presets.
     * Repository-check bypasses are never renderer-configurable. */
    arguments: z.array(z.string().min(1).max(128)).max(32).superRefine((args, context) => {
      if (args.some((argument) => argument.toLowerCase() === '--skip-git-repo-check')) {
        context.addIssue({ code: 'custom', message: 'The Codex repository-check bypass is controlled by Interleaf execution mode.' });
      }
    }),
    defaultModel: z.string().trim().max(128).nullable(),
    /** Bounded, user-owned list of model identifiers the installed CLI accepts.
     * Main also asks the installed CLIs what they accept where a listing
     * mechanism exists (docs/CLI_CAPABILITIES.md §7.9), but that catalog is
     * runtime-only: this list plus the repo-evidenced seeds is the persisted
     * part of the allowlist main uses to accept a per-run model from the
     * renderer, and it is what covers a CLI that publishes no list. Preference
     * documents persisted before this field existed load as an empty list. */
    models: agentProfileModelsSchema.default([]),
    reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).nullable(),
    permissionMode: z.enum(['workspace-write', 'normal', 'unsafe-yolo']),
    sandboxMode: z.enum(AGENT_DEFAULT_EXECUTION_MODES),
    /** A capability handle is selected per run; no renderer path is stored. */
    /** Directory capability handles are intentionally selected for each run.
     * Reuse is not persisted until a main-owned handle registry exists. */
    workingDirectoryPolicy: z.enum(['select-per-run']),
    /** Environment values never cross the renderer. Entries are allowlisted
     * host-variable names to inherit or explicit names to clear. */
    environmentOverrides: z.array(z.object({
      name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u),
      action: z.enum(['inherit-allowlisted', 'clear']),
    }).strict()).max(32),
  }).strict()).superRefine((profiles, context) => {
    for (const profileId of Object.keys(profiles)) {
      if (!BUILT_IN_AGENT_PROFILE_ID_SET.has(profileId)) {
        context.addIssue({ code: 'custom', path: [profileId], message: 'Only built-in agent profile preferences may be stored in settings.' });
      }
    }
  }).default({}),
}).superRefine((agent, context) => {
  const handles = new Set(agent.workingDirectories.map((entry) => entry.handle));
  if (agent.defaultWorkingDirectory !== null && !handles.has(agent.defaultWorkingDirectory)) {
    context.addIssue({
      code: 'custom',
      path: ['defaultWorkingDirectory'],
      message: 'The default working directory must reference a saved working directory.',
    });
  }
  for (const [profileId, handle] of Object.entries(agent.defaultWorkingDirectoryByProfile)) {
    if (!handles.has(handle)) {
      context.addIssue({
        code: 'custom',
        path: ['defaultWorkingDirectoryByProfile', profileId],
        message: 'A profile default must reference a saved working directory.',
      });
    }
  }
});

/**
 * The one active local-server profile.
 *
 * A single profile rather than a list: the MVP question a reader has is "which
 * server am I using right now", and one endpoint keeps the invariant that main
 * validates exactly one address per request. `endpoint` is re-validated in main
 * before every connection — this schema is the first gate, not the only one, so
 * a settings document edited outside the app cannot introduce a non-loopback
 * address.
 *
 * `model` is a bare identifier and is deliberately *not* checked against the
 * server's catalog here: a settings document must stay loadable while the
 * server is stopped, so an unrecognized selection is reported by the provider
 * rather than silently discarded along with every other preference.
 */
const localProviderSettingsSchema = z.object({
  mode: z.enum(LOCAL_ENDPOINT_MODES).default('ollama'),
  endpoint: z.string()
    .trim()
    .max(LOCAL_ENDPOINT_MAX_LENGTH)
    .refine(isLoopbackEndpoint, LOOPBACK_ENDPOINT_MESSAGES.host)
    .default(DEFAULT_LOCAL_ENDPOINT),
  /** Model identifier the local server published; `null` means "not chosen". */
  model: z.string().trim().min(1).max(128).nullable().default(null),
});

/**
 * The provider/model a *new* Reader Chat session binds to when the user has
 * explicitly chosen one, or `null` for "no preference".
 *
 * Both halves are named because a provider alone is not a usable binding for
 * the providers that expose a catalog, and `modelId` stays nullable for the
 * providers whose contract already accepts "the runtime's own default". This
 * records a *choice*, not a readiness claim: readiness is re-derived from live
 * detection at use, and a default that is no longer ready is reported rather
 * than silently replaced with another — possibly paid — provider.
 */
const defaultChatBindingSchema = z.object({
  providerId: aiProviderIdSchema,
  modelId: modelIdSchema.nullable(),
}).strict();

/**
 * How new Reader Chat conversations are named: `'auto'` (a lightweight model
 * from the conversation's own provider), an explicit provider and model, or
 * `null` (off). Separate from every chat binding; main re-verifies identity,
 * readiness and the model on every use and never falls back to another.
 */
const conversationNamingSchema = z.union([
  z.literal('auto'),
  z.object({ providerId: aiProviderIdSchema, modelId: modelIdSchema }).strict(),
]).nullable();

const aiSettingsSchema = z.object({
  openRouterModel: openRouterModelIdSchema.default('openrouter/auto'),
  /** Defaulted `null` so documents written before this field loaded unchanged. */
  defaultChat: defaultChatBindingSchema.nullable().default(null),
  /** Defaulted to automatic for fresh profiles and documents written before it. */
  conversationNaming: conversationNamingSchema.default('auto'),
  /**
   * Defaulted so a settings document written before the local provider existed
   * still loads with every other preference intact, rather than failing
   * validation and being replaced wholesale by defaults.
   */
  local: localProviderSettingsSchema.prefault({}),
});

/** The document orderings the library list/grid may be sorted by. Kept in step
 * with `DocumentSortOption`; main validates the same values on every query. */
const DOCUMENT_SORT_OPTIONS = [
  'recent_added',
  'recent_read',
  'title_asc',
  'title_desc',
  'author_asc',
] as const satisfies readonly DocumentSortOption[];

const LIBRARY_VIEW_MODES = ['grid', 'list'] as const;

/**
 * How the library opens. These are starting points, not a lock: the session's
 * own view and sort choices stay in the renderer and are never written back
 * here, so changing folders or sorting once does not rewrite the preference.
 */
const librarySettingsSchema = z.object({
  defaultView: z.enum(LIBRARY_VIEW_MODES).default('grid'),
  defaultSort: z.enum(DOCUMENT_SORT_OPTIONS).default('recent_added'),
});

/**
 * Privacy preferences that change what leaves the application.
 *
 * `confirmExternalLinks` adds a native confirmation before a document's link is
 * handed to the desktop browser. It defaults to off so existing one-click
 * behaviour is unchanged, and it is enforced in main — the renderer asking for
 * a link is not what decides whether the user is asked.
 */
const privacySettingsSchema = z.object({
  confirmExternalLinks: z.boolean().default(false),
});

/**
 * Advanced diagnostics. Debug records are extra detail inside the existing
 * bounded, redacted logging sink; enabling them adds no new destination, no
 * unbounded retention, and no exemption from redaction.
 */
const advancedSettingsSchema = z.object({
  debugLogging: z.boolean().default(false),
});

/**
 * Application updates. Automatic checks only ask the pinned stable release
 * destination whether a newer signed release exists; downloading and
 * installing always wait for an explicit action. Defaults on, with the opt-out
 * in Settings › About & Updates.
 */
const updateSettingsSchema = z.object({
  automaticChecks: z.boolean().default(true),
});

/**
 * Guided-onboarding progress.
 *
 * Bounded content only: a version, a status, the last stage the user actually
 * acted on and one completion timestamp. No probe log, credential, executable
 * path, provider error body or document text may ever be stored here — this
 * section is written by an untrusted renderer through `settings:update` and
 * read back on every launch.
 *
 * The section is defaulted, so its *absence* from a stored document is what
 * tells main the install predates onboarding. That evidence is consumed by the
 * launch-state latch in main before any normalization write can erase it.
 */
export const onboardingSettingsSchema = z.object({
  version: z.literal(ONBOARDING_SETTINGS_VERSION).default(ONBOARDING_SETTINGS_VERSION),
  status: z.enum(ONBOARDING_STATUSES).default('not-started'),
  lastStageAcknowledged: z.enum(ONBOARDING_STAGES).nullable().default(null),
  /** ISO-8601, written once when the flow is completed. */
  completedAt: z.iso.datetime().nullable().default(null),
}).strict();

// Every section but the two that have no default is `prefault({})`: an absent
// section is parsed from an empty object, so each field's own `.default` above
// is the one place its default is written, for a fresh profile, a document that
// predates the section, and `DEFAULT_APP_SETTINGS` alike.
export const appSettingsSchema = z.object({
  /** Settings shape version — bump when a migration must rewrite stored JSON. */
  version: z.literal(1),
  appearance: appearanceSettingsSchema,
  reader: readerSettingsSchema.prefault({}),
  layout: layoutSettingsSchema.prefault({}),
  agent: agentSettingsSchema,
  ai: aiSettingsSchema.prefault({}),
  // Sections added after the first shipped shape. Each one is defaulted so a
  // settings document written before it existed still loads unchanged instead
  // of failing validation and discarding every other preference.
  library: librarySettingsSchema.prefault({}),
  privacy: privacySettingsSchema.prefault({}),
  advanced: advancedSettingsSchema.prefault({}),
  companion: companionSettingsSchema.prefault({}),
  updates: updateSettingsSchema.prefault({}),
  onboarding: onboardingSettingsSchema.prefault({}),
});

export type LocalProviderSettings = z.infer<typeof localProviderSettingsSchema>;
export type LibrarySettings = z.infer<typeof librarySettingsSchema>;
export type AppSettings = z.infer<typeof appSettingsSchema>;
/** Input shape accepted by migration/update boundaries; nested defaults such
 * as the profile map may be omitted by older callers and are materialized by
 * the schema parser. */
export type AppSettingsInput = z.input<typeof appSettingsSchema>;

/**
 * A fresh profile's settings: the two sections that have no default, with every
 * other value taken from the schema's own field defaults.
 */
export const DEFAULT_APP_SETTINGS: AppSettings = appSettingsSchema.parse({
  version: 1,
  appearance: { palette: DEFAULT_PALETTE },
  agent: { defaultExecutionMode: DEFAULT_AGENT_EXECUTION_MODE },
});
