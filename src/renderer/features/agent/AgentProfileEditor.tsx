import { useEffect, useState, type ReactElement } from 'react';
import type { AppSettings } from '@shared/schemas/settings';
import type { AgentProfile, AgentWorkingDirectory } from '@shared/types/agent';
import { MAX_AGENT_PROFILE_MODELS } from '@shared/schemas/agent-model';
import { isAgentModelIdentifier } from '@shared/constants/agent-models';
import { toSelectableDefaultExecutionMode } from '@shared/constants/agent-mode-selection';
import { defaultProfilePreference, type AgentProfilePreference, type ProfileEditorDefinition } from './profile-preferences';
import { modelListHelpText } from './model-options';
import { AgentDefaultModelField } from './AgentDefaultModelField';
import { AgentModelRefreshButton } from './AgentModelRefreshButton';
import { AgentProfileEnvironment } from './AgentProfileEnvironment';
import { AgentProfileWorkingDirectory } from './AgentProfileWorkingDirectory';
import { Select } from '../../components/ui/select';
import type { SelectOption } from '../../components/ui/select-model';
import { BUILT_IN_WORKING_DIRECTORY_OPTIONS, DEFAULT_SANDBOX_OPTIONS, UNSUPPORTED_EFFORT_OPTIONS, argumentPresetOptions } from './profile-select-options';

const EFFORT_OPTIONS_BY_PROVIDER: Readonly<Record<string, readonly SelectOption[]>> = {
  // Item O correction: this repository has evidence that Codex accepts generic
  // `-c key=value` overrides, but not that `model_reasoning_effort` is the key
  // it reads for effort. Main refuses to start a Codex profile that carries an
  // effort rather than sending an unverified key the CLI would accept and
  // ignore, so the only selectable value here is the provider default — which
  // is also how a profile that stored an effort before this change is cleared.
  codex: [
    { value: '', label: 'Provider default (effort selection unavailable)' },
  ],
  antigravity: [
    { value: '', label: 'Provider default' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
  ],
  'claude-code': [
    { value: '', label: 'Provider default' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'X-High' },
    { value: 'max', label: 'Max' },
  ],
  opencode: [
    { value: '', label: 'Provider default' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'max', label: 'Max' },
  ],
};

/**
 * Settings editor for exactly ONE built-in profile, rendered inside the
 * expanded provider that uses it (design 5d). Exactly one editor is mounted at
 * a time — the one belonging to the open provider row — so saved per-profile
 * values, validation, warnings and main-owned boundaries stay unchanged per
 * editor and no built-in profile has a second editing surface.
 */
export function AgentProfileEditor({
  definition,
  settings,
  availableModels,
  onModelsRefreshed,
  workingDirectories,
  onChange,
}: {
  readonly definition: ProfileEditorDefinition;
  readonly settings: AppSettings;
  /** Main's model allowlist for this profile: whatever the installed CLI
   * reported, merged with the entries below. Empty when the CLI has no listing
   * mechanism or has not been probed yet. */
  readonly availableModels: readonly string[];
  /** Receives main's refreshed profiles after an explicit CLI re-probe. */
  readonly onModelsRefreshed: (profiles: readonly AgentProfile[]) => void;
  readonly workingDirectories: readonly AgentWorkingDirectory[];
  readonly onChange: (next: AppSettings) => void;
}): ReactElement {
  const current = settings.agent.profiles[definition.id] ?? defaultProfilePreference(definition);
  const updateProfile = (patch: Partial<NonNullable<AgentProfilePreference>>): void => {
    onChange({
      ...settings,
      agent: {
        ...settings.agent,
        profiles: { ...settings.agent.profiles, [definition.id]: { ...current, ...patch } },
      },
    });
  };
  const isUnsafeCodex = definition.id === 'codex' && current.permissionMode === 'unsafe-yolo';
  // Free text is only normalized on blur so intermediate typing is not
  // rewritten under the caret. Only the committed, validated list is persisted.
  const currentModels = current.models;
  const persistedModels = currentModels.join('\n');
  const [modelsDraft, setModelsDraft] = useState(persistedModels);
  const [modelsRejected, setModelsRejected] = useState(0);
  // Adopt the stored list only when it actually changes underneath the editor
  // (profile switch or a settings reload). A local commit already matches it,
  // so this never rewrites the caret mid-edit and never clears the rejection
  // notice that the same commit just produced.
  useEffect(() => { setModelsDraft(persistedModels); }, [persistedModels]);
  useEffect(() => { setModelsRejected(0); }, [definition.id]);
  const commitModels = (): void => {
    const seen = new Set<string>();
    const accepted: string[] = [];
    let rejected = 0;
    for (const line of modelsDraft.split('\n')) {
      const candidate = line.trim();
      if (candidate.length === 0) continue;
      if (!isAgentModelIdentifier(candidate) || accepted.length >= MAX_AGENT_PROFILE_MODELS) { rejected += 1; continue; }
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      accepted.push(candidate);
    }
    setModelsRejected(rejected);
    setModelsDraft(accepted.join('\n'));
    if (accepted.length !== currentModels.length || accepted.some((model, index) => model !== currentModels[index])) {
      updateProfile({ models: accepted });
    }
  };
  const effortOptions = EFFORT_OPTIONS_BY_PROVIDER[definition.id];
  return (
    <fieldset data-testid={`profile-editor-${definition.id}`} className="flex min-w-0 flex-col gap-3">
      <legend className="settings-field-label">Agent profile</legend>
      <span className="settings-field-note">How Interleaf starts this agent for Agent Mode tasks.</span>
      <div className="settings-field-grid">
        <label className="settings-field">
          <span className="settings-field-label">Binary</span>
          <input data-testid={`profile-${definition.id}-binary`} readOnly value={current.binary} className="settings-control settings-control--mono" />
        </label>
        <label className="settings-field">
          <span className="settings-field-label">Arguments</span>
          <Select
            data-testid={`profile-${definition.id}-arguments`}
            value={isUnsafeCodex ? 'unsafe-yolo' : 'safe'}
            options={argumentPresetOptions(definition)}
            onValueChange={(preset) => {
              if (preset === 'unsafe-yolo') {
                updateProfile({ arguments: ['exec', '--json', '--yolo'], permissionMode: 'unsafe-yolo' });
              } else updateProfile({ arguments: [...definition.safeArguments], permissionMode: definition.id === 'codex' ? 'workspace-write' : current.permissionMode === 'unsafe-yolo' ? 'normal' : current.permissionMode });
            }}
            className="settings-control--mono"
          />
        </label>
        <AgentDefaultModelField
          profileId={definition.id}
          availableModels={availableModels}
          defaultModel={current.defaultModel}
          onChange={(defaultModel) => { updateProfile({ defaultModel }); }}
        />
        <label className="settings-field">
          <span className="settings-field-label">Reasoning effort</span>
          {effortOptions !== undefined ? (
            <Select
              data-testid={`profile-${definition.id}-reasoning`}
              value={current.reasoningEffort ?? ''}
              options={effortOptions}
              onValueChange={(effort) => {
                updateProfile({ reasoningEffort: (effort || null) as NonNullable<AgentProfilePreference>['reasoningEffort'] });
              }}
            />
          ) : (
            <Select
              data-testid={`profile-${definition.id}-reasoning`}
              disabled
              value=""
              options={UNSUPPORTED_EFFORT_OPTIONS}
              onValueChange={() => undefined}
              aria-label="Reasoning effort not supported"
            />
          )}
        </label>
        <label className="settings-field">
          <span className="settings-field-label">Permission mode</span>
          <input data-testid={`profile-${definition.id}-permission`} readOnly value={current.permissionMode} className={`settings-control ${isUnsafeCodex ? 'text-danger' : ''}`} />
        </label>
        <label className="settings-field">
          <span className="settings-field-label">Sandbox mode</span>
          {/* Container Sandbox is not offered: no verified executor exists, so
              main always resolves it fail-closed. A legacy persisted value stays
              in the settings document and is displayed as the recommended
              default until the user picks something else. */}
          <Select
            data-testid={`profile-${definition.id}-sandbox`}
            value={toSelectableDefaultExecutionMode(current.sandboxMode)}
            options={DEFAULT_SANDBOX_OPTIONS}
            onValueChange={(sandboxMode) => { updateProfile({ sandboxMode }); }}
          />
        </label>
      </div>
      <label className="settings-field">
        <span className="settings-field-label">Available models · one per line</span>
        <textarea
          data-testid={`profile-${definition.id}-models`}
          rows={3}
          spellCheck={false}
          value={modelsDraft}
          aria-describedby={`profile-${definition.id}-models-help`}
          placeholder="One model identifier per line"
          onChange={(event) => { setModelsDraft(event.target.value); }}
          onBlur={commitModels}
          className="settings-control settings-control--mono"
        />
        <span id={`profile-${definition.id}-models-help`} className="settings-field-note">
          {modelListHelpText(availableModels, MAX_AGENT_PROFILE_MODELS)}
        </span>
        <AgentModelRefreshButton onRefreshed={onModelsRefreshed} />
        {modelsRejected > 0 && (
          <span role="alert" data-testid={`profile-${definition.id}-models-rejected`} className="settings-field-note text-danger">
            {modelsRejected} entr{modelsRejected === 1 ? 'y was' : 'ies were'} discarded: model identifiers must be single tokens without spaces or quotes.
          </span>
        )}
      </label>
      <AgentProfileWorkingDirectory profileId={definition.id} settings={settings} directories={workingDirectories} onChange={onChange} />
      <label className="settings-field">
        <span className="settings-field-label">Run folder</span>
        <Select data-testid={`profile-${definition.id}-working-directory`} disabled value={current.workingDirectoryPolicy} options={BUILT_IN_WORKING_DIRECTORY_OPTIONS} onValueChange={() => undefined} aria-describedby={`profile-${definition.id}-working-directory-help`} />
        <span id={`profile-${definition.id}-working-directory-help`} className="settings-field-note">Choose the project folder this agent works in by default. You can pick a different folder for any run.</span>
      </label>
      <AgentProfileEnvironment profileId={definition.id} overrides={current.environmentOverrides} onChange={(environmentOverrides) => { updateProfile({ environmentOverrides }); }} />
      {isUnsafeCodex && <p role="alert" className="rounded-md bg-danger/10 p-2 text-2xs text-danger">Unsafe Codex permission bypass is enabled. Review the explicit warning before starting each direct-workspace run.</p>}
    </fieldset>
  );
}
