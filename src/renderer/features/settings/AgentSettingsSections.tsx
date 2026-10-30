import { AGENT_EXECUTION_MODE_INFO } from '@shared/constants/agent-modes';
import { AGENT_SELECTABLE_DEFAULT_EXECUTION_MODES, toSelectableDefaultExecutionMode } from '@shared/constants/agent-mode-selection';
import type { AgentProfile, AgentWorkingDirectory } from '@shared/types/agent';
import { CustomAgentProfilesPanel } from '../agent/CustomAgentProfilesPanel';
import { AgentWorkingDirectoriesSettings } from '../agent/AgentWorkingDirectoriesSettings';
import { directoryProfiles } from '../agent/working-directory-options';
import type { SettingsSectionProps } from './PreferenceSettingsSections';
import { Select } from '../../components/ui/select';
import { SettingsSectionHeader } from '../../components/ui/settings-section-header';

const DEFAULT_MODE_OPTIONS = AGENT_SELECTABLE_DEFAULT_EXECUTION_MODES.map((mode) => ({ value: mode, label: AGENT_EXECUTION_MODE_INFO[mode].label }));

export function CustomProfilesSettingsSection() {
  // Built-in profiles are edited inside their provider row; this section owns
  // custom profiles only, so no built-in profile has a second editor.
  return (
    <section aria-labelledby="settings-custom-profiles-heading">
      <SettingsSectionHeader id="settings-custom-profiles-heading" title="Custom Profiles" description="Agents you set up yourself. Built-in agents such as Codex or Claude Code are set up under AI Providers, in their own rows." />
      <CustomAgentProfilesPanel />
    </section>
  );
}

export function WorkingDirectoriesSettingsSection({ settings, onChange, availableProfiles, workingDirectories }: SettingsSectionProps & {
  readonly availableProfiles: readonly AgentProfile[];
  readonly workingDirectories: readonly AgentWorkingDirectory[];
}) {
  return (
    <section aria-labelledby="settings-working-directories-heading">
      <SettingsSectionHeader id="settings-working-directories-heading" title="Agent Working Directories" description="Project folders an agent may work in. Add a folder here once, then pick it for any run." />
      <div>
        <AgentWorkingDirectoriesSettings settings={settings} directories={workingDirectories} profiles={directoryProfiles(availableProfiles, settings.agent.defaultWorkingDirectoryByProfile)} onChange={onChange} />
      </div>
    </section>
  );
}

export function SandboxingSettingsSection({ settings, onChange }: SettingsSectionProps) {
  // A legacy persisted `container-sandbox` default is left untouched in
  // storage and still fails closed in main; the editor shows the recommended
  // default rather than an option that can never run.
  const selectedDefaultExecutionMode = toSelectableDefaultExecutionMode(settings.agent.defaultExecutionMode);
  return (
    <section aria-labelledby="settings-sandboxing-heading">
      <SettingsSectionHeader id="settings-sandboxing-heading" title="Agent Sandboxing" description="The isolation new agent runs start from. Modes that work directly in your folder are never a saved default: you confirm them for that folder and agent each time." />
      <label className="block max-w-sm text-xs text-text-secondary">Default execution mode
        <Select
          aria-label="Default execution mode"
          data-testid="settings-agent-default-execution-mode"
          value={selectedDefaultExecutionMode}
          aria-describedby="settings-agent-default-execution-mode-help"
          options={DEFAULT_MODE_OPTIONS}
          onValueChange={(mode) => { onChange({ ...settings, agent: { ...settings.agent, defaultExecutionMode: mode } }); }}
          wrapperClassName="mt-2"
        />
      </label>
      <p id="settings-agent-default-execution-mode-help" className="mt-2 max-w-sm text-2xs leading-relaxed text-text-secondary">{AGENT_EXECUTION_MODE_INFO[selectedDefaultExecutionMode].description}</p>
      <p className="mt-2 max-w-sm text-2xs leading-relaxed text-text-secondary">Native Restricted and Active Environment are chosen for one run at a time, and each asks you to confirm.</p>
    </section>
  );
}
