import type { AppSettings } from '@shared/schemas/settings';

/** The persisted preference record for one built-in agent profile. */
export type AgentProfilePreference = AppSettings['agent']['profiles'][string];

/**
 * Built-in profile presets shared by the Settings editor and the Agent
 * composer.
 *
 * `binary` is a known CLI id (never a user-supplied path) and `safeArguments`
 * are the allowlisted argv presets main revalidates. Both surfaces must build
 * profile preferences from this single table so the composer can persist a
 * model default without inventing a second, drifting argv preset.
 *
 * GitHub Copilot is deliberately absent: main refuses it for unattended Agent
 * Mode and no longer registers it, so no surface offers it. Its `copilot` id
 * and binary remain in the settings schema only so legacy preferences parse.
 */
export const PROFILE_EDITOR_DEFINITIONS: readonly {
  readonly id: string;
  readonly name: string;
  readonly binary: NonNullable<AgentProfilePreference>['binary'];
  readonly safeArguments: readonly string[];
}[] = [
  { id: 'codex', name: 'Codex', binary: 'codex', safeArguments: ['exec', '--json', '--sandbox', 'workspace-write'] },
  { id: 'claude-code', name: 'Claude Code', binary: 'claude', safeArguments: ['--print', '--output-format', 'stream-json', '--verbose'] },
  { id: 'antigravity', name: 'Antigravity', binary: 'agy', safeArguments: ['--print', '--output-format', 'stream-json'] },
  { id: 'opencode', name: 'OpenCode', binary: 'opencode', safeArguments: ['run', '--format', 'json'] },
  { id: 'pi', name: 'Pi', binary: 'pi', safeArguments: [] },
  // Derived from Cursor's published CLI documentation and NOT verified against
  // an installed binary; main revalidates this preset against its own allowlist.
  { id: 'cursor', name: 'Cursor', binary: 'cursor-agent', safeArguments: ['--print', '--output-format', 'stream-json'] },
];

export type ProfileEditorDefinition = (typeof PROFILE_EDITOR_DEFINITIONS)[number];

export function findProfileEditorDefinition(profileId: string): ProfileEditorDefinition | undefined {
  return PROFILE_EDITOR_DEFINITIONS.find((definition) => definition.id === profileId);
}

export function defaultProfilePreference(definition: ProfileEditorDefinition): NonNullable<AgentProfilePreference> {
  return {
    binary: definition.binary,
    arguments: [...definition.safeArguments],
    defaultModel: null,
    models: [],
    reasoningEffort: null,
    permissionMode: definition.id === 'codex' ? 'workspace-write' : 'normal',
    sandboxMode: 'auto-isolated',
    workingDirectoryPolicy: 'select-per-run',
    environmentOverrides: [],
  };
}
