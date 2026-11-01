import { useCallback, useState } from 'react';
import type { AgentProfile, AgentWorkingDirectory } from '@shared/types/agent';

export type AgentResources = {
  readonly profiles: readonly AgentProfile[];
  readonly workingDirectories: readonly AgentWorkingDirectory[];
  /** Adopts the profiles and working directories a load read. */
  readonly adoptLoaded: (profiles: readonly AgentProfile[], directories: readonly AgentWorkingDirectory[]) => void;
  /** Replaces the profiles after an editor re-read them. */
  readonly setProfiles: (profiles: readonly AgentProfile[]) => void;
};

/** Owns the agent profiles and working directories the agent sections show. */
export function useAgentResources(): AgentResources {
  const [profiles, setProfiles] = useState<readonly AgentProfile[]>([]);
  const [workingDirectories, setWorkingDirectories] = useState<readonly AgentWorkingDirectory[]>([]);

  const adoptLoaded = useCallback((
    loadedProfiles: readonly AgentProfile[],
    directories: readonly AgentWorkingDirectory[]
  ): void => {
    setProfiles(loadedProfiles);
    setWorkingDirectories(directories);
  }, []);

  return { profiles, workingDirectories, adoptLoaded, setProfiles };
}
