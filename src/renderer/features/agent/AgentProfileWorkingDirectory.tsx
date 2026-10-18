import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { MAX_SAVED_WORKING_DIRECTORIES, type AppSettings } from '@shared/schemas/settings';
import type { AgentWorkingDirectory } from '@shared/types/agent';
import { bridge } from '../../app/api-client';
import { Select } from '../../components/ui/select';

const SELECT_PER_RUN = '';

/**
 * Per-profile saved working-directory default, shown inside the provider that
 * uses it (design 5d).
 *
 * Renderer state holds the opaque handle and the safe display name only: the
 * canonical path stays main-owned, the native chooser is the sole way a new
 * directory enters the list, and a default here grants no filesystem access on
 * its own — a run still receives its capability from main.
 */
export function AgentProfileWorkingDirectory({
  profileId,
  settings,
  directories,
  onChange,
}: {
  readonly profileId: string;
  readonly settings: AppSettings;
  readonly directories: readonly AgentWorkingDirectory[];
  readonly onChange: (next: AppSettings) => void;
}): ReactElement {
  const [status, setStatus] = useState<string | null>(null);
  const saved = settings.agent.workingDirectories;
  const mapped = settings.agent.defaultWorkingDirectoryByProfile[profileId] ?? SELECT_PER_RUN;
  // Main's live capability list arrives separately from settings, so a
  // directory chosen here is merged in at once instead of waiting for a reload.
  // Options and their availability then read from the same up-to-date state and
  // cannot disagree about a handle that was just saved. Handles and display
  // names only: no canonical path enters renderer state.
  const [knownDirectories, setKnownDirectories] = useState<readonly AgentWorkingDirectory[]>(directories);
  useEffect(() => { setKnownDirectories(directories); }, [directories]);
  const availableHandles = useMemo(
    () => new Set(knownDirectories.map((entry) => entry.handle)),
    [knownDirectories],
  );
  const options = useMemo(() => {
    const entries = saved.map((entry) => ({
      handle: entry.handle,
      label: availableHandles.has(entry.handle) ? entry.displayName : `${entry.displayName} (unavailable)`,
    }));
    // A mapped default with no saved row left has no display name to show.
    if (mapped !== SELECT_PER_RUN && !entries.some((entry) => entry.handle === mapped)) {
      entries.push({ handle: mapped, label: 'Unavailable saved directory' });
    }
    return entries;
  }, [saved, availableHandles, mapped]);

  const persist = (agent: AppSettings['agent']): void => { onChange({ ...settings, agent }); };

  const setDefaultHandle = (handle: string): void => {
    const next = Object.fromEntries(
      Object.entries(settings.agent.defaultWorkingDirectoryByProfile).filter(([id]) => id !== profileId)
    );
    if (handle !== SELECT_PER_RUN) next[profileId] = handle;
    persist({ ...settings.agent, defaultWorkingDirectoryByProfile: next });
    setStatus(handle === SELECT_PER_RUN ? 'This profile will select a directory per run.' : 'Saved default directory for this profile.');
  };

  const chooseDirectory = async (): Promise<void> => {
    try {
      const selected = await bridge.agent.selectWorkingDirectory();
      if (selected === null) {
        setStatus('Working-directory selection cancelled.');
        return;
      }
      const known = saved.some((entry) => entry.handle === selected.handle);
      if (!known && saved.length >= MAX_SAVED_WORKING_DIRECTORIES) {
        setStatus(`You can save at most ${String(MAX_SAVED_WORKING_DIRECTORIES)} working directories.`);
        return;
      }
      const workingDirectories = known
        ? saved.map((entry) => entry.handle === selected.handle ? { handle: selected.handle, displayName: selected.displayName } : entry)
        : [...saved, { handle: selected.handle, displayName: selected.displayName }];
      persist({
        ...settings.agent,
        workingDirectories,
        defaultWorkingDirectoryByProfile: {
          ...settings.agent.defaultWorkingDirectoryByProfile,
          [profileId]: selected.handle,
        },
      });
      setKnownDirectories((current) => current.some((entry) => entry.handle === selected.handle)
        ? current.map((entry) => entry.handle === selected.handle ? selected : entry)
        : [...current, selected]);
      setStatus(`Saved default directory “${selected.displayName}” for this profile.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Working-directory selection failed.');
    }
  };

  return (
    <div className="settings-field">
      <span className="settings-field-label" id={`profile-${profileId}-working-directory-default-label`}>Working directory</span>
      <div className="flex min-w-0 items-center gap-2">
        <Select
          data-testid={`profile-${profileId}-working-directory-default`}
          aria-labelledby={`profile-${profileId}-working-directory-default-label`}
          value={mapped}
          options={[{ value: SELECT_PER_RUN, label: 'None — select per run' }, ...options.map((entry) => ({ value: entry.handle, label: entry.label }))]}
          onValueChange={(handle) => { setDefaultHandle(handle); }}
          wrapperClassName="flex-1"
        />
        <button
          type="button"
          data-testid={`profile-${profileId}-choose-working-directory`}
          onClick={() => { void chooseDirectory(); }}
          className="settings-inline-action"
        >
          Choose…
        </button>
      </div>
      <span className="settings-field-note">Used as this agent's starting folder. You can choose a different folder for any run.</span>
      {status !== null && <span role="status" aria-live="polite" className="settings-field-note">{status}</span>}
    </div>
  );
}
