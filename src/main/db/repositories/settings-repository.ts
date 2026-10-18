import type { InterleafDatabase } from '../database';
import { appSettingsSchema, BUILT_IN_AGENT_PROFILE_IDS, DEFAULT_APP_SETTINGS, type AppSettings, type AppSettingsInput } from '@shared/schemas/settings';
import type { Logger } from '../../logging/logger';
import { replaceUnknownPalettes } from './settings-palette-fallback';
import { InterleafError } from '@shared/errors/interleaf-error';
import { isAgentModelIdentifier } from '@shared/constants/agent-models';
import { type PortableRecord, type PortableRecordDraft, type PortableValue, parsePortableJson } from '@shared/models/portable';

const PROFILE_BINARIES: Readonly<Record<string, string>> = {
  codex: 'codex',
  'claude-code': 'claude',
  antigravity: 'agy',
  copilot: 'copilot',
  opencode: 'opencode',
  pi: 'pi',
  cursor: 'cursor-agent',
};
const ALLOWED_PROFILE_PRESETS: Readonly<Record<string, readonly {
  readonly args: readonly string[];
  readonly permissionMode: 'workspace-write' | 'normal' | 'unsafe-yolo' | 'fixture';
}[]>> = {
  codex: [
    { args: ['exec', '--json', '--sandbox', 'workspace-write'], permissionMode: 'workspace-write' },
    { args: ['exec', '--json', '--yolo'], permissionMode: 'unsafe-yolo' },
  ],
  'claude-code': [
    { args: ['--print', '--output-format', 'stream-json', '--verbose'], permissionMode: 'normal' },
  ],
  antigravity: [
    { args: ['--print', '--output-format', 'stream-json'], permissionMode: 'normal' },
  ],
  copilot: [
    { args: ['--stream', 'on'], permissionMode: 'normal' },
  ],
  opencode: [
    { args: ['run', '--format', 'json'], permissionMode: 'normal' },
  ],
  pi: [
    { args: [], permissionMode: 'normal' },
  ],
  // Derived from Cursor's published CLI documentation and NOT verified against
  // an installed binary. One preset only: the documented `--force` approval
  // bypass is not offered, so no persisted preference can reach it.
  cursor: [
    { args: ['--print', '--output-format', 'stream-json'], permissionMode: 'normal' },
  ],
};
const ALLOWED_PROFILE_REASONING_EFFORTS: Readonly<Record<string, ReadonlySet<string>>> = {
  codex: new Set(['low', 'medium', 'high']),
  'claude-code': new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  antigravity: new Set(['low', 'medium', 'high']),
  opencode: new Set(['low', 'medium', 'high', 'max']),
};
const SAFE_ENVIRONMENT_NAMES = new Set(['PATH', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TEMP', 'TMP', 'USER']);
/**
 * Typed access to the application settings KV store. Corrupt or missing
 * entries degrade to defaults with a logged warning — the app must still
 * start (master prompt §85: never crash on bad input), but never silently.
 */
export class SettingsRepository {
  private readonly savedListeners = new Set<(settings: AppSettings) => void>();

  constructor(
    private readonly db: InterleafDatabase,
    private readonly log: Logger
  ) {}

  get(): AppSettings {
    const row = this.db.raw
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get(SETTINGS_KEY) as { value_json?: PortableValue } | undefined;

    if (row === undefined) {
      return cloneDefaults();
    }
    if (typeof row.value_json !== 'string') {
      this.log.warn('settings row has non-string value_json; using defaults');
      return cloneDefaults();
    }

    let parsed: PortableValue;
    try {
      parsed = parsePortableJson(row.value_json);
    } catch (error) {
      this.log.warn('stored settings are not valid JSON; using defaults', {
        reason: error instanceof Error ? error.message : String(error),
      });
      return cloneDefaults();
    }

    const result = appSettingsSchema.safeParse(replaceUnknownPalettes(migrateLegacySettings(parsed)));
    if (!result.success) {
      this.log.warn('stored settings failed schema validation; using defaults', {
        issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      });
      return cloneDefaults();
    }
    try {
      validateAgentProfileSettings(result.data);
      return result.data;
    } catch (error) {
      this.log.warn('stored agent profile settings failed main-owned validation; using defaults', {
        reason: error instanceof Error ? error.message : String(error),
      });
      return cloneDefaults();
    }
  }

  update(next: AppSettingsInput): AppSettings {
    const validated = appSettingsSchema.parse(next);
    validateAgentProfileSettings(validated);
    this.db.raw
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES (?, ?, datetime('now', 'utc'))
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
           updated_at = excluded.updated_at`
      )
      .run(SETTINGS_KEY, JSON.stringify(validated));
    for (const listener of [...this.savedListeners]) listener(validated);
    return validated;
  }

  /** Main-owned observers of each successful write; returns the unsubscribe. */
  onSaved(listener: (settings: AppSettings) => void): () => void {
    this.savedListeners.add(listener);
    return () => { this.savedListeners.delete(listener); };
  }
}

/** Main-owned second-stage validation for profile preferences. The shared
 * schema bounds shape; this function binds it to known adapters, known argv
 * presets, and the minimal non-secret environment allowlist. It is exported
 * for IPC/repository security tests and deliberately does not expose paths. */
export function validateAgentProfileSettings(settings: AppSettings): void {
  for (const [profileId, profile] of Object.entries(settings.agent.profiles)) {
    const expectedBinary = PROFILE_BINARIES[profileId];
    if (expectedBinary === undefined || profile.binary !== expectedBinary) {
      throw new InterleafError('validation', `Agent profile '${profileId}' must use its main-owned binary.`);
    }
    const presets = ALLOWED_PROFILE_PRESETS[profileId];
    if (!presets) {
      throw new InterleafError('validation', `Agent profile '${profileId}' is not a recognized profile.`);
    }
    const matchingPreset = presets.find(
      (preset) => JSON.stringify(profile.arguments) === JSON.stringify(preset.args)
    );
    if (!matchingPreset) {
      throw new InterleafError('validation', `Arguments for agent profile '${profileId}' are not an allowlisted preset.`);
    }
    if (profile.permissionMode !== matchingPreset.permissionMode) {
      if (matchingPreset.permissionMode === 'unsafe-yolo') {
        throw new InterleafError('validation', 'Codex --yolo requires the conspicuous unsafe permission mode.');
      }
      throw new InterleafError(
        'validation',
        `Agent profile '${profileId}' with preset '${profile.arguments.join(' ')}' requires permission mode '${matchingPreset.permissionMode}', but received '${profile.permissionMode}'.`
      );
    }
    if (profile.permissionMode === 'unsafe-yolo' && (profileId !== 'codex' || matchingPreset.permissionMode !== 'unsafe-yolo')) {
      throw new InterleafError('validation', 'Unsafe permission mode is available only for the explicit Codex --yolo preset.');
    }
    if (profile.reasoningEffort !== null) {
      const allowedEfforts = ALLOWED_PROFILE_REASONING_EFFORTS[profileId];
      if (!allowedEfforts) {
        throw new InterleafError('validation', `Agent profile '${profileId}' does not support reasoning effort selection.`);
      }
      if (!allowedEfforts.has(profile.reasoningEffort)) {
        throw new InterleafError('validation', `Reasoning effort '${profile.reasoningEffort}' is not supported for agent profile '${profileId}'.`);
      }
    }
    if (profile.defaultModel !== null && !isAgentModelIdentifier(profile.defaultModel)) {
      throw new InterleafError('validation', `Default model for agent profile '${profileId}' must be a valid identifier.`);
    }
    for (const override of profile.environmentOverrides) {
      if (!SAFE_ENVIRONMENT_NAMES.has(override.name)) {
        throw new InterleafError('validation', `Environment variable '${override.name}' is not in Interleaf's non-secret allowlist.`);
      }
    }
  }
}

const SETTINGS_KEY = 'app';

/** Normalize the short-lived Phase 10 preview of directory reuse before the
 * strict schema runs. Reusing a renderer-stored path was never permitted; an
 * older preference is therefore safely downgraded to the current capability
 * policy instead of invalidating the complete settings document. */
function migrateLegacySettings(value: PortableValue): PortableValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const root = value as PortableRecord;
  const agent = root.agent;
  if (typeof agent !== 'object' || agent === null || Array.isArray(agent)) return value;
  const agentRecord = agent as PortableRecord;
  const profiles = agentRecord.profiles;
  const defaultsByProfile = agentRecord.defaultWorkingDirectoryByProfile;
  if ((typeof profiles !== 'object' || profiles === null || Array.isArray(profiles))
    && (typeof defaultsByProfile !== 'object' || defaultsByProfile === null || Array.isArray(defaultsByProfile))) return value;
  const migratedProfiles: PortableRecordDraft = {};
  if (typeof profiles === 'object' && profiles !== null && !Array.isArray(profiles)) for (const [profileId, profile] of Object.entries(profiles as PortableRecord)) {
    // Older previews accepted arbitrary keys. Drop those stale entries during
    // the compatibility pass; custom profiles are rehydrated by their own
    // main-owned repository and never belong in settings.agent.profiles.
    if (!BUILT_IN_AGENT_PROFILE_IDS.some((id) => id === profileId)) continue;
    if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) {
      migratedProfiles[profileId] = profile;
      continue;
    }
    const candidate = profile as PortableRecord;
    const allowedEfforts = ALLOWED_PROFILE_REASONING_EFFORTS[profileId];
    const rawEffort = candidate.reasoningEffort;
    const isSupportedEffort =
      rawEffort === null ||
      (typeof rawEffort === 'string' && (allowedEfforts?.has(rawEffort) ?? false));
    const rawDefaultModel = candidate.defaultModel;
    const isCleanDefaultModel =
      rawDefaultModel === null ||
      rawDefaultModel === undefined ||
      (typeof rawDefaultModel === 'string' && isAgentModelIdentifier(rawDefaultModel));

    migratedProfiles[profileId] = {
      ...candidate,
      ...(candidate.workingDirectoryPolicy === 'reuse-last-selected'
        ? { workingDirectoryPolicy: 'select-per-run' }
        : {}),
      ...(!isSupportedEffort ? { reasoningEffort: null } : {}),
      ...(!isCleanDefaultModel ? { defaultModel: null } : {}),
    };
  }
  const migratedDefaults: PortableRecordDraft = {};
  if (typeof defaultsByProfile === 'object' && defaultsByProfile !== null && !Array.isArray(defaultsByProfile)) {
    for (const [profileId, handle] of Object.entries(defaultsByProfile as PortableRecord)) {
      // Fake was never a real installed profile. Drop only its stale
      // preference while preserving all other appearance/layout settings.
      if (profileId === 'fake') continue;
      migratedDefaults[profileId] = handle;
    }
  }
  return {
    ...root,
    agent: {
      ...agentRecord,
      ...(typeof profiles === 'object' && profiles !== null && !Array.isArray(profiles) ? { profiles: migratedProfiles } : {}),
      ...(typeof defaultsByProfile === 'object' && defaultsByProfile !== null && !Array.isArray(defaultsByProfile) ? { defaultWorkingDirectoryByProfile: migratedDefaults } : {}),
    },
  };
}

function cloneDefaults(): AppSettings {
  return structuredClone(DEFAULT_APP_SETTINGS);
}
