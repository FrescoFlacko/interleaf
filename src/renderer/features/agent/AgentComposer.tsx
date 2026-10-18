import { useEffect, useRef, type ReactElement } from 'react';
import type { AgentExecutionMode } from '@shared/constants/agent-modes';
import { toSelectableExecutionMode } from '@shared/constants/agent-mode-selection';
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import type { AppSettings } from '@shared/schemas/settings';
import { MAX_AGENT_PROFILE_MODELS, isAgentModelIdentifier } from '@shared/constants/agent-models';
import { persistSettings } from '../../app/api-client';
import { useAgentStore } from '../../stores/use-agent-store';
import { selectActiveDocument, useReaderStore } from '../../stores/use-reader-store';
import { useUiStore } from '../../stores/use-ui-store';
import { defaultProfilePreference, findProfileEditorDefinition } from './profile-preferences';
import { AgentSessionView } from './AgentSessionView';
import { AgentTaskView } from './AgentTaskView';
import './agent-design.css';

/**
 * The Agent tab has two states, and they are separate surfaces rather than one
 * growing form: the new-task view (reference 6a) and the run view (6b). This
 * component owns only what both need — hydration for the open document and the
 * two preferences the composer writes back to settings.
 */
export function AgentComposer(): ReactElement {
  const activeDocument = useReaderStore(selectActiveDocument);
  const activeSession = useAgentStore((state) => state.activeSession);
  const selectedProfileId = useAgentStore((state) => state.selectedProfileId);
  const profiles = useAgentStore((state) => state.profiles);
  const loadedSettings = useUiStore((state) => state.loadedSettings);
  const setLoadedSettings = useUiStore((state) => state.setLoadedSettings);
  const setComposerExecutionMode = useUiStore((state) => state.setComposerExecutionMode);

  useEffect(() => {
    void useAgentStore.getState().hydrate(activeDocument?.id ?? null);
  }, [activeDocument?.id]);

  const profileDefaultMode = profiles.find((profile) => profile.id === selectedProfileId)?.defaultSandboxMode;
  const observedProfileId = useRef<string | null>(null);

  useEffect(() => {
    const previousProfileId = observedProfileId.current;
    observedProfileId.current = selectedProfileId;
    if (previousProfileId === null || selectedProfileId === null) return;
    if (previousProfileId === selectedProfileId || profileDefaultMode === undefined) return;
    // A legacy profile default that is no longer offered (container-sandbox)
    // must not leave the composer on a mode the picker cannot represent.
    setComposerExecutionMode(toSelectableExecutionMode(profileDefaultMode));
  }, [profileDefaultMode, selectedProfileId, setComposerExecutionMode]);

  function handleModeChange(mode: AgentExecutionMode): void {
    setComposerExecutionMode(mode);
    // Direct-workspace modes are deliberate, single-run choices and can never
    // become a persisted default.
    if (mode === 'active-env' || mode === 'native-restricted') return;
    const base = loadedSettings ?? DEFAULT_APP_SETTINGS;
    const next: AppSettings = { ...base, agent: { ...base.agent, defaultExecutionMode: mode } };
    setLoadedSettings(next);
    persistSettings(next);
  }

  /**
   * The composer's model choice is the same preference the Settings editor
   * owns, so it is written back to `agent.profiles[id].defaultModel` instead of
   * becoming a second source of truth. Custom profiles are main-owned and are
   * never addressable through renderer settings, so their choice stays
   * session-local.
   */
  function handleModelChange(model: string | null): void {
    useAgentStore.getState().setSelectedModel(model);
    if (selectedProfileId === null) return;
    const definition = findProfileEditorDefinition(selectedProfileId);
    if (definition === undefined) return;
    const base = loadedSettings ?? DEFAULT_APP_SETTINGS;
    const currentPreference = base.agent.profiles[definition.id] ?? defaultProfilePreference(definition);
    if (base.agent.profiles[definition.id]?.defaultModel === model) return;
    const next: AppSettings = {
      ...base,
      agent: {
        ...base.agent,
        profiles: {
          ...base.agent.profiles,
          [definition.id]: { ...currentPreference, defaultModel: model, models: retainedModels(currentPreference) },
        },
      },
    };
    setLoadedSettings(next);
    useAgentStore.setState({
      profiles: useAgentStore.getState().profiles.map((profile) =>
        profile.id === definition.id ? { ...profile, defaultModel: model } : profile
      ),
    });
    persistSettings(next);
  }

  return (
    <div className="agent-design flex h-full min-h-0 flex-1 flex-col">
      {activeSession === null ? (
        <AgentTaskView
          activeDocument={activeDocument}
          onModeChange={handleModeChange}
          onModelChange={handleModelChange}
        />
      ) : (
        <AgentSessionView session={activeSession} />
      )}
    </div>
  );
}

/**
 * The outgoing default is one of the options this picker just offered, so it is
 * carried into the profile's own list: switching away from it — or to "Provider
 * default" — never silently removes it. A legacy value that predates the
 * identifier grammar is dropped rather than failing the whole write.
 */
function retainedModels(preference: { readonly models: string[]; readonly defaultModel: string | null }): string[] {
  const retained = preference.models;
  const previous = preference.defaultModel;
  const keep = previous !== null
    && isAgentModelIdentifier(previous)
    && !retained.includes(previous)
    && retained.length < MAX_AGENT_PROFILE_MODELS;
  return keep ? [...retained, previous] : retained;
}
