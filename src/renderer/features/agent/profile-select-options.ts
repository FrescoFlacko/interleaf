import { AGENT_EXECUTION_MODE_INFO } from '@shared/constants/agent-modes';
import {
  AGENT_SELECTABLE_DEFAULT_EXECUTION_MODES,
  type SelectableAgentDefaultExecutionMode,
} from '@shared/constants/agent-mode-selection';
import type { CustomAgentEnvironmentOverride } from '@shared/types/custom-agent-profile';
import type { SelectOption } from '../../components/ui/select-model';
import type { ProfileEditorDefinition } from './profile-preferences';

type ShellFamily = 'posix' | 'powershell' | 'cmd';
type PromptDelivery = 'stdin' | 'temp-file';
type StdoutParsing = 'text' | 'json-lines' | 'none';
type CustomEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | '';

/** Container Sandbox is not offered: no verified executor exists. */
export const DEFAULT_SANDBOX_OPTIONS: readonly SelectOption<SelectableAgentDefaultExecutionMode>[] =
  AGENT_SELECTABLE_DEFAULT_EXECUTION_MODES.map((mode) => ({ value: mode, label: AGENT_EXECUTION_MODE_INFO[mode].label }));

export const ENVIRONMENT_ACTION_OPTIONS: readonly SelectOption<CustomAgentEnvironmentOverride['action']>[] = [
  { value: 'inherit-allowlisted', label: 'Pass through' },
  { value: 'clear', label: 'Clear' },
];

export const SHELL_FAMILY_OPTIONS: readonly SelectOption<ShellFamily>[] = [
  { value: 'posix', label: 'POSIX (-lc COMMAND)' },
  { value: 'powershell', label: 'PowerShell (-NoProfile -NonInteractive -Command COMMAND)' },
  { value: 'cmd', label: 'Command Prompt (/d /s /c COMMAND)' },
];

export const EXPERT_PROMPT_DELIVERY_OPTIONS: readonly SelectOption<'stdin'>[] = [
  { value: 'stdin', label: 'Standard input (required for expert shell)' },
];

export const PROMPT_DELIVERY_OPTIONS: readonly SelectOption<PromptDelivery>[] = [
  { value: 'stdin', label: 'Standard input' },
  { value: 'temp-file', label: 'Temporary file ({{promptFile}})' },
];

export const STDOUT_PARSING_OPTIONS: readonly SelectOption<StdoutParsing>[] = [
  { value: 'text', label: 'Text' },
  { value: 'json-lines', label: 'JSON lines' },
  { value: 'none', label: 'None' },
];

export const CUSTOM_EFFORT_OPTIONS: readonly SelectOption<CustomEffort>[] = [
  { value: '', label: 'None' },
  ...(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const).map((value) => ({ value, label: value })),
];

export const CUSTOM_WORKING_DIRECTORY_OPTIONS: readonly SelectOption<'select-per-run'>[] = [
  { value: 'select-per-run', label: 'Chosen for each run' },
];

export const BUILT_IN_WORKING_DIRECTORY_OPTIONS: readonly SelectOption<'select-per-run'>[] = [
  { value: 'select-per-run', label: 'Chosen for each run' },
];

export const UNSUPPORTED_EFFORT_OPTIONS: readonly SelectOption[] = [
  { value: '', label: 'Not supported by this agent' },
];

/** The safe argument preset, plus the unsafe Codex bypass. */
export function argumentPresetOptions(definition: ProfileEditorDefinition): SelectOption<'safe' | 'unsafe-yolo'>[] {
  const safe = { value: 'safe' as const, label: definition.safeArguments.length > 0 ? definition.safeArguments.join(' ') : '(no extra arguments)' };
  return definition.id === 'codex' ? [safe, { value: 'unsafe-yolo', label: 'exec --json --yolo (unsafe)' }] : [safe];
}

export const CUSTOM_ENVIRONMENT_ACTION_OPTIONS: readonly SelectOption<CustomAgentEnvironmentOverride['action']>[] = [
  { value: 'inherit-allowlisted', label: 'Pass through' },
  { value: 'clear', label: 'Clear' },
];
