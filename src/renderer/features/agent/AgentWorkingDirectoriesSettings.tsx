import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { MAX_SAVED_WORKING_DIRECTORIES, type AppSettings } from '@shared/schemas/settings';
import type { AgentProfile, AgentWorkingDirectory } from '@shared/types/agent';
import { bridge } from '../../app/api-client';
import { Select } from '../../components/ui/select';
import { SELECT_PER_RUN, directoryOptions } from './working-directory-options';

type AgentWorkingDirectoriesSettingsProps = {
  readonly settings: AppSettings;
  readonly directories: readonly AgentWorkingDirectory[];
  readonly profiles: readonly Pick<AgentProfile, 'id' | 'name'>[];
  readonly onChange: (next: AppSettings) => void;
};

function profileLabel(profile: Pick<AgentProfile, 'id' | 'name'>): string {
  return profile.name.trim().length > 0 ? profile.name : profile.id;
}

function staleProfileIdentifier(profileId: string): string {
  const trimmed = profileId.trim();
  if (trimmed.length === 0) return 'unknown profile';
  return trimmed.length > 128 ? `${trimmed.slice(0, 125)}…` : trimmed;
}

/**
 * Settings-only projection of main-owned working-directory capabilities.
 * Renderer state contains opaque handles and safe display names only; the
 * durable directory row remains owned by AgentService and is never deleted
 * from this surface.
 */
export function AgentWorkingDirectoriesSettings({
  settings,
  directories,
  profiles,
  onChange,
}: AgentWorkingDirectoriesSettingsProps): ReactElement {
  const [status, setStatus] = useState<string | null>(null);
  const [knownDirectories, setKnownDirectories] = useState<readonly AgentWorkingDirectory[]>(directories);
  useEffect(() => { setKnownDirectories(directories); }, [directories]);
  const availableByHandle = useMemo(
    () => new Map(knownDirectories.map((directory) => [directory.handle, directory])),
    [knownDirectories],
  );
  const savedByHandle = useMemo(
    () => new Map(settings.agent.workingDirectories.map((directory) => [directory.handle, directory])),
    [settings.agent.workingDirectories],
  );
  const visibleProfiles = useMemo(() => {
    const unique = new Map<string, Pick<AgentProfile, 'id' | 'name'>>();
    for (const profile of profiles) {
      if (!unique.has(profile.id)) unique.set(profile.id, profile);
    }
    return [...unique.values()];
  }, [profiles]);
  const visibleProfileIds = useMemo(() => new Set(visibleProfiles.map((profile) => profile.id)), [visibleProfiles]);
  const staleProfileIds = Object.keys(settings.agent.defaultWorkingDirectoryByProfile)
    .filter((profileId) => !visibleProfileIds.has(profileId));

  const staleSaved = settings.agent.workingDirectories.filter(
    (directory) => !availableByHandle.has(directory.handle),
  );
  const activeSaved = settings.agent.workingDirectories.filter(
    (directory) => availableByHandle.has(directory.handle),
  );

  const cleanSettings = (extraActiveHandles: readonly string[] = []): AppSettings => {
    const activeHandles = new Set([...knownDirectories.map((directory) => directory.handle), ...extraActiveHandles]);
    const workingDirectories = settings.agent.workingDirectories.filter((directory) => activeHandles.has(directory.handle));
    const defaultWorkingDirectory = settings.agent.defaultWorkingDirectory !== null && activeHandles.has(settings.agent.defaultWorkingDirectory)
      ? settings.agent.defaultWorkingDirectory
      : null;
    const defaultWorkingDirectoryByProfile = Object.fromEntries(
      Object.entries(settings.agent.defaultWorkingDirectoryByProfile)
        .filter(([, handle]) => activeHandles.has(handle)),
    );
    return {
      ...settings,
      agent: {
        ...settings.agent,
        defaultWorkingDirectory,
        workingDirectories,
        defaultWorkingDirectoryByProfile,
      },
    };
  };

  const persist = (nextAgent: AppSettings['agent']): void => {
    onChange({ ...settings, agent: nextAgent });
  };

  const addDirectory = async (): Promise<void> => {
    if (activeSaved.length >= MAX_SAVED_WORKING_DIRECTORIES) {
      setStatus(`You can save at most ${String(MAX_SAVED_WORKING_DIRECTORIES)} global working directories.`);
      return;
    }
    setStatus(null);
    try {
      const selected = await bridge.agent.selectWorkingDirectory();
      if (selected === null) {
        setStatus('Working-directory selection cancelled.');
        return;
      }
      if (savedByHandle.has(selected.handle)) {
        if (!availableByHandle.has(selected.handle)) {
          const base = cleanSettings([selected.handle]);
          const nextWorkingDirectories = base.agent.workingDirectories.map((directory) =>
            directory.handle === selected.handle
              ? { handle: selected.handle, displayName: selected.displayName }
              : directory,
          );
          persist({
            ...base.agent,
            workingDirectories: nextWorkingDirectories,
          });
          setKnownDirectories((current) => current.some((directory) => directory.handle === selected.handle)
            ? current.map((directory) => directory.handle === selected.handle ? selected : directory)
            : [...current, selected]);
          setStatus(`Refreshed global working directory “${selected.displayName}”.`);
          return;
        }
        setStatus('That working directory is already saved globally.');
        return;
      }
      const base = cleanSettings();
      if (base.agent.workingDirectories.length >= MAX_SAVED_WORKING_DIRECTORIES) {
        setStatus(`You can save at most ${String(MAX_SAVED_WORKING_DIRECTORIES)} global working directories.`);
        return;
      }
      persist({
        ...base.agent,
        workingDirectories: [...base.agent.workingDirectories, {
          handle: selected.handle,
          displayName: selected.displayName,
        }],
      });
      setKnownDirectories((current) => current.some((directory) => directory.handle === selected.handle)
        ? current
        : [...current, selected]);
      setStatus(`Saved global working directory “${selected.displayName}”.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Working-directory selection failed.');
    }
  };

  const removeDirectory = (handle: string): void => {
    const base = cleanSettings();
    persist({
      ...base.agent,
      defaultWorkingDirectory: base.agent.defaultWorkingDirectory === handle ? null : base.agent.defaultWorkingDirectory,
      workingDirectories: base.agent.workingDirectories.filter((directory) => directory.handle !== handle),
      defaultWorkingDirectoryByProfile: Object.fromEntries(
        Object.entries(base.agent.defaultWorkingDirectoryByProfile)
          .filter(([, mappedHandle]) => mappedHandle !== handle),
      ),
    });
    setStatus('Folder removed from this list. The folder itself and its files were not changed.');
  };

  const setDefaultWorkspace = (handle: string): void => {
    const base = cleanSettings();
    const nextHandle = handle !== SELECT_PER_RUN && base.agent.workingDirectories.some((directory) => directory.handle === handle)
      ? handle
      : null;
    persist({ ...base.agent, defaultWorkingDirectory: nextHandle });
    setStatus(nextHandle === null ? 'Default workspace cleared. Profiles will select one per run.' : `Saved default workspace “${directoryOptionLabel(nextHandle)}”.`);
  };

  const setProfileDefault = (profileId: string, handle: string): void => {
    const base = cleanSettings();
    const nextDefaults = Object.fromEntries(
      Object.entries(base.agent.defaultWorkingDirectoryByProfile)
        .filter(([mappedProfileId]) => mappedProfileId !== profileId),
    );
    if (handle !== SELECT_PER_RUN && base.agent.workingDirectories.some((directory) => directory.handle === handle)) {
      nextDefaults[profileId] = handle;
    }
    persist({ ...base.agent, defaultWorkingDirectoryByProfile: nextDefaults });
    setStatus(handle === SELECT_PER_RUN ? `${profileId} will select a directory per run.` : `Saved default directory for ${profileId}.`);
  };

  const removeStaleProfileDefault = (profileId: string): void => {
    const base = cleanSettings();
    persist({
      ...base.agent,
      defaultWorkingDirectoryByProfile: Object.fromEntries(
        Object.entries(base.agent.defaultWorkingDirectoryByProfile)
          .filter(([mappedProfileId]) => mappedProfileId !== profileId),
      ),
    });
    setStatus('Removed the stale runtime-profile default from settings.');
  };

  const directoryOptionLabel = (handle: string): string => {
    const directory = availableByHandle.get(handle) ?? savedByHandle.get(handle);
    return directory === undefined ? 'Unavailable saved directory' : directory.displayName;
  };

  const defaultWorkspaceHandle = settings.agent.defaultWorkingDirectory;
  const defaultWorkspaceIsStale = defaultWorkspaceHandle !== null && !availableByHandle.has(defaultWorkspaceHandle);
  return (
    <section aria-labelledby="settings-agent-directories-heading" className="rounded-lg border border-border-subtle bg-bg-surface p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 id="settings-agent-directories-heading" className="text-sm font-semibold">Working Directory Defaults</h4>
          <p className="mt-1 text-xs leading-relaxed text-text-secondary">Save the project folders you work in, then pick a default folder for each agent.</p>
        </div>
        <button type="button" onClick={() => { void addDirectory(); }} disabled={activeSaved.length >= MAX_SAVED_WORKING_DIRECTORIES} className="shrink-0 rounded border border-border-subtle px-2 py-1 text-xs hover:bg-bg-primary disabled:opacity-40">Add directory…</button>
      </div>

      <div className="mt-3 border-t border-border-subtle pt-3" aria-labelledby="settings-default-workspace-heading">
        <h5 id="settings-default-workspace-heading" className="text-xs font-semibold">Default Agent Workspace</h5>
        <p className="mt-1 text-2xs text-text-secondary">Automatically selected in the Agent Task Composer when starting new tasks.</p>
        <div className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-2">
          <label htmlFor="agent-default-workspace" className="min-w-0 truncate text-xs text-text-secondary">Default workspace</label>
          <Select
            id="agent-default-workspace"
            data-testid="agent-default-workspace"
            aria-label="Default Agent workspace"
            size="sm"
            value={defaultWorkspaceHandle ?? SELECT_PER_RUN}
            options={directoryOptions(activeSaved, defaultWorkspaceIsStale ? defaultWorkspaceHandle : null, directoryOptionLabel)}
            onValueChange={setDefaultWorkspace}
            wrapperClassName="min-w-0"
          />
        </div>
      </div>

      <div className="mt-4 border-t border-border-subtle pt-3" aria-label="Global Working Directories">
        <h5 className="text-xs font-semibold">Global Working Directories</h5>
        <ul className="mt-2 space-y-1" aria-label="Saved global working directories">
          {activeSaved.length === 0 && staleSaved.length === 0 && <li className="rounded border border-border-subtle p-2 text-xs text-text-secondary">No global directories saved. Profiles will select one per run.</li>}
          {activeSaved.map((directory) => (
            <li key={directory.handle} className="flex items-center justify-between gap-2 rounded border border-border-subtle p-2">
              <span className="min-w-0 truncate text-xs text-text-primary">{directory.displayName}</span>
              <button type="button" aria-label={`Remove global working directory ${directory.displayName}`} onClick={() => { removeDirectory(directory.handle); }} className="shrink-0 rounded border border-border-subtle px-2 py-1 text-2xs text-danger hover:bg-bg-primary">Remove</button>
            </li>
          ))}
          {staleSaved.map((directory) => (
            <li key={`stale-${directory.handle}`} className="flex items-center justify-between gap-2 rounded border border-warning/40 bg-warning/5 p-2">
              <span className="min-w-0 text-xs text-text-secondary"><span className="font-medium text-warning">Unavailable:</span> {directory.displayName}<span className="ml-1 text-2xs">(select it again)</span></span>
              <button type="button" aria-label={`Remove unavailable working directory ${directory.displayName}`} onClick={() => { removeDirectory(directory.handle); }} className="shrink-0 rounded border border-border-subtle px-2 py-1 text-2xs text-danger hover:bg-bg-primary">Remove</button>
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-4 border-t border-border-subtle pt-3" aria-labelledby="settings-profile-directory-defaults-heading">
        <h5 id="settings-profile-directory-defaults-heading" className="text-xs font-semibold">Default Working Directory by Profile</h5>
        <p className="mt-1 text-2xs text-text-secondary">Choose None to select a capability for each run. Defaults are settings only and do not grant or revoke filesystem access.</p>
        <div className="mt-2 space-y-2">
          {visibleProfiles.length === 0 && <p className="rounded border border-border-subtle p-2 text-xs text-text-secondary">No runtime profiles are available.</p>}
          {visibleProfiles.map((profile) => {
            const mappedHandle = settings.agent.defaultWorkingDirectoryByProfile[profile.id];
            const mappedIsStale = mappedHandle !== undefined && !availableByHandle.has(mappedHandle);
            return (
              <div key={profile.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-2">
                <label htmlFor={`profile-default-working-directory-${profile.id}`} aria-label={`Default working directory for ${profileLabel(profile)}`} className="min-w-0 truncate text-xs text-text-secondary">Default directory</label>
                <Select
                  id={`profile-default-working-directory-${profile.id}`}
                  aria-label={`Default working directory for ${profileLabel(profile)}`}
                  size="sm"
                  value={mappedHandle ?? SELECT_PER_RUN}
                  options={directoryOptions(activeSaved, mappedIsStale ? mappedHandle : null, directoryOptionLabel)}
                  onValueChange={(handle) => { setProfileDefault(profile.id, handle); }}
                  wrapperClassName="min-w-0"
                />
              </div>
            );
          })}
          {staleProfileIds.map((profileId) => (
            <div key={`stale-profile-${profileId}`} className="flex items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2">
              <span className="flex min-w-0 flex-col gap-0.5"><span className="text-xs font-medium text-warning">Default for a removed agent</span><span className="settings-field-note truncate">{staleProfileIdentifier(profileId)} is no longer available, so this default is never used.</span></span>
              <button type="button" aria-label={`Remove stale runtime-profile default for profile ${staleProfileIdentifier(profileId)}`} onClick={() => { removeStaleProfileDefault(profileId); }} className="settings-inline-action settings-inline-action--danger shrink-0">Remove</button>
            </div>
          ))}
        </div>
      </div>

      {status !== null && <p role="status" aria-live="polite" className="mt-3 rounded border border-border-subtle bg-bg-primary p-2 text-2xs text-text-secondary">{status}</p>}
    </section>
  );
}
