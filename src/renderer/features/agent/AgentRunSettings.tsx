import type { ReactElement } from 'react';
import { AGENT_EXECUTION_MODE_INFO, type AgentExecutionMode } from '@shared/constants/agent-modes';
import type { AgentProfile } from '@shared/types/agent';
import { useAgentStore } from '../../stores/use-agent-store';
import { useUiStore } from '../../stores/use-ui-store';
import { Badge, BadgeDot } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { CardHeader, CardLabel } from '../../components/ui/card';
import { Select } from '../../components/ui/select';
import { CompanionCard } from '../../components/companion/CompanionCard';
import { workingDirectorySourceLabel } from './agent-session-state';
import { AgentProfileNotes, AgentProfilePicker, AgentRuntimeEmptyState } from './AgentProfileField';
import { agentProfileView } from './agent-profile-view';
import { findProfileEditorDefinition } from './profile-preferences';
import { agentModelOptions, executionModeOptions, isInstalled } from './agent-run-options';

const SECTION = 'flex flex-col gap-2 px-4 py-3';
const FIELD_LABEL = 'text-xs font-medium text-text-secondary';
const CAPTION = 'text-xs text-text-secondary';

type AgentRunSettingsProps = {
  readonly disabled: boolean;
  readonly onModeChange: (mode: AgentExecutionMode) => void;
  readonly onModelChange: (model: string | null) => void;
};

/**
 * The "Run settings" card: the working directory, then one row of picker
 * chips (agent, model, environment) matching Reader Chat's provider and model
 * chips, with each choice's status and caption below the row.
 */
export function AgentRunSettings({ disabled, onModeChange, onModelChange }: AgentRunSettingsProps): ReactElement {
  const openSettings = useUiStore((state) => state.openSettings);
  const executionMode = useUiStore((state) => state.composer.executionMode);
  const profiles = useAgentStore((state) => state.profiles);
  const modeAvailability = useAgentStore((state) => state.modeAvailability);
  const selectedProfileId = useAgentStore((state) => state.selectedProfileId);
  const selectedModel = useAgentStore((state) => state.selectedModel);

  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId);
  const directWorkspaceMode = executionMode === 'active-env' || executionMode === 'native-restricted';
  const profileView = agentProfileView(profiles, selectedProfileId);

  if (profileView.kind === 'none-installed') {
    // Nothing can run, so there is nothing to configure: no directory, model,
    // environment or sandbox status, just the one way forward.
    return (
      <CompanionCard>
        <CardHeader>
          <CardLabel className="mr-auto">Run settings</CardLabel>
        </CardHeader>
        <AgentRuntimeEmptyState stale={profileView.stale} />
      </CompanionCard>
    );
  }

  return (
    <CompanionCard>
      <CardHeader>
        <CardLabel className="mr-auto">Run settings</CardLabel>
        <Button
          size="inline"
          variant="link"
          data-testid="agent-open-working-directory-settings"
          onClick={() => { openSettings('working-directories'); }}
        >
          Manage directories
        </Button>
      </CardHeader>

      <WorkingDirectoryField disabled={disabled} />

      <div className={SECTION} data-testid="agent-run-configuration">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <AgentProfilePicker disabled={disabled} />
          <Select
            id="agent-model"
            variant="chip"
            title="Model"
            aria-label="Agent model"
            aria-describedby="agent-model-help"
            data-testid="agent-model-select"
            disabled={(selectedProfile?.availableModels ?? []).length === 0 || disabled}
            value={selectedModel ?? ''}
            options={agentModelOptions(selectedProfile)}
            onValueChange={(model) => { onModelChange(model === '' ? null : model); }}
          />
          <Select
            id="composer-execution-mode"
            variant="chip"
            title="Execution environment"
            data-testid="composer-execution-mode-select"
            aria-label="Execution environment"
            aria-describedby="agent-execution-help"
            disabled={disabled}
            value={executionMode}
            options={executionModeOptions(modeAvailability)}
            onValueChange={onModeChange}
          />
        </div>
        <AgentProfileNotes />
        <ModelHelp profile={selectedProfile} />
        <div className="flex min-w-0 items-start gap-2">
          <Badge tone={directWorkspaceMode ? 'warning' : 'success'} data-testid="agent-execution-risk">
            <BadgeDot />
            {directWorkspaceMode ? 'Direct workspace' : 'Sandboxed'}
          </Badge>
          {/* Direct-workspace modes stay gated: `agent:start` still requires a
              fresh main-issued single-use grant and main's own confirmation
              dialog. The picker only marks the selection, and says so. */}
          <p id="agent-execution-help" className={`${CAPTION} min-w-0 flex-1`}>
            {executionMode === 'auto-isolated'
              ? 'Git repositories resolve to Isolated Worktree; non-Git directories resolve to Isolated Directory Copy.'
              : AGENT_EXECUTION_MODE_INFO[executionMode].description}
            {directWorkspaceMode ? ' You confirm this mode in a system dialog before it runs.' : ''}
          </p>
        </div>
      </div>
    </CompanionCard>
  );
}

function WorkingDirectoryField({ disabled }: { readonly disabled: boolean }): ReactElement {
  const workingDirectory = useAgentStore((state) => state.workingDirectory);
  const workingDirectorySource = useAgentStore((state) => state.workingDirectorySource);
  return (
    <div className={`${SECTION} border-b border-border-subtle`}>
      <span className={FIELD_LABEL} id="agent-working-directory-label">Working directory</span>
      <div className="flex items-center gap-2">
        <div
          data-testid="agent-working-directory"
          aria-labelledby="agent-working-directory-label"
          className={
            'agent-dashed flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-border-subtle px-3 text-sm ' +
            (workingDirectory === null ? 'bg-bg-surface text-text-secondary' : 'text-text-primary')
          }
        >
          <span className="min-w-0 truncate" title={workingDirectory?.displayName ?? undefined}>
            {workingDirectory?.displayName ?? 'No folder selected'}
          </span>
        </div>
        <Button
          disabled={disabled}
          onClick={() => { void useAgentStore.getState().selectWorkingDirectory(); }}
        >
          Choose…
        </Button>
      </div>
      <p className={CAPTION} data-testid="agent-working-directory-source">
        {workingDirectorySourceLabel(workingDirectory !== null, workingDirectorySource)}
        <span>
          {workingDirectory === null
            ? ' · Choose the project folder the agent should work in.'
            : ' · Agent runs start in this folder. Choose… to use another.'}
        </span>
      </p>
    </div>
  );
}

/**
 * Main's own allowlist projection decides what may be offered; anything outside
 * it would be rejected by `agent:start`, so unsupported combinations are never
 * presented as choices.
 */
function modelCaption(profile: AgentProfile | undefined): string {
  if (profile === undefined) return 'Choose an agent first.';
  // A stale stored choice has no CLI to ask.
  if (!isInstalled(profile)) return 'Models are listed once an installed agent is selected.';
  if (!profile.capabilities.modelSelection) return `${profile.name} does not support choosing a model.`;
  if (profile.availableModels.length > 0) return 'Used for the next run. Resuming a session keeps the model it started with.';
  return profile.isCustom
    ? 'Add a default model to this custom profile, under Custom profiles, to choose one here.'
    : `${profile.name} did not list any models. Add the ones it accepts in its AI Providers settings.`;
}

/**
 * The model caption, with a way to the one place that can fix an empty list:
 * a built-in agent's own AI Providers row, where its Models field lives.
 */
function ModelHelp({ profile }: { readonly profile: AgentProfile | undefined }): ReactElement {
  const openSettings = useUiStore((state) => state.openSettings);
  const fixable = profile !== undefined
    && isInstalled(profile)
    && profile.capabilities.modelSelection
    && profile.availableModels.length === 0
    && !profile.isCustom
    && findProfileEditorDefinition(profile.id) !== undefined;
  return (
    <p id="agent-model-help" className={CAPTION}>
      {modelCaption(profile)}
      {fixable && (
        <>
          {' '}
          <Button
            size="inline"
            variant="link"
            data-testid="agent-open-model-settings"
            onClick={() => { openSettings(`ai:${profile.id}`); }}
          >
            Open {profile.name} settings
          </Button>
        </>
      )}
    </p>
  );
}
