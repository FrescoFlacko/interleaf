import type { AgentProfile, AgentWorkingDirectory } from '@shared/types/agent';
import type { SelectOption } from '../../components/ui/select-model';
import { isInstalled } from './agent-run-options';

export const SELECT_PER_RUN = '';

/**
 * Options for a default-directory picker: none, then the saved directories.
 * A stored default that is no longer available stays listed and flagged so
 * the picker still shows what is saved.
 */
export function directoryOptions(
  activeSaved: readonly AgentWorkingDirectory[],
  staleHandle: string | null,
  labelFor: (handle: string) => string,
): SelectOption[] {
  const options: SelectOption[] = [{ value: SELECT_PER_RUN, label: 'None — select per run' }];
  if (staleHandle !== null) options.push({ value: staleHandle, label: `Unavailable — ${labelFor(staleHandle)}` });
  return [...options, ...activeSaved.map((directory) => ({ value: directory.handle, label: directory.displayName }))];
}

/**
 * Profiles that get a default-directory row: every installed profile, plus an
 * absent one that already has a saved default, marked so it is not mistaken
 * for a runnable agent and its stored choice is not silently dropped.
 */
export function directoryProfiles(
  profiles: readonly AgentProfile[],
  defaults: Readonly<Record<string, string>>,
): Pick<AgentProfile, 'id' | 'name'>[] {
  return profiles
    .filter((profile) => isInstalled(profile) || profile.id in defaults)
    .map((profile) => (isInstalled(profile) ? profile : { id: profile.id, name: `${profile.name} (not installed)` }));
}
