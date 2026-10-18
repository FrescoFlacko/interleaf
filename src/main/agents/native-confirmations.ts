import type { AgentRiskLevel } from '@shared/constants/agent-modes';

export type NativeWarningDialogOptions = {
  readonly type: 'warning';
  readonly buttons: [string, string];
  readonly defaultId: 0;
  readonly cancelId: 0;
  readonly title: string;
  readonly message: string;
};

/**
 * Builds the dedicated native confirmation shown when a user creates or edits
 * an Expert Shell profile. Keep this separate from the generic unsafe-profile
 * warning: Expert Shell is a distinct critical-risk capability.
 */
export function createExpertShellProfileConfirmationOptions(profileName: string): NativeWarningDialogOptions {
  return {
    type: 'warning',
    buttons: ['Cancel', 'Enable Expert Shell'],
    defaultId: 0,
    cancelId: 0,
    title: 'Enable Expert Shell profile',
    message: `Expert Shell profile “${profileName}” executes its configured shell command with your full OS user authority. This is a critical-risk capability that can access or modify anything your account can access. Interleaf will require a separate native confirmation before every start and resume. Enable this profile?`,
  };
}

export type DangerousAgentRunConfirmationInput = {
  readonly profileName: string;
  readonly canonicalTargetPath: string;
  readonly riskLevel: AgentRiskLevel;
  readonly expertShell?: boolean;
};

/** Builds the native warning for one exact agent run or resume. */
export function createDangerousAgentRunConfirmationOptions(input: DangerousAgentRunConfirmationInput): NativeWarningDialogOptions {
  const expertShell = input.expertShell === true;
  const message = expertShell
    ? `CRITICAL: Expert Shell profile “${input.profileName}” will execute its configured shell command with your full OS user authority in ${input.canonicalTargetPath}. It may create, modify, or delete files and access any resource your account can access. Interleaf requires this native confirmation for this exact Expert Shell start or resume and will ask again for every run. Continue?`
    : `The agent “${input.profileName}” is ${input.riskLevel === 'critical' ? 'unsafe or' : ''} unverified for this run. Renderer-configured executables/argv are not trusted. It will run once in the main-owned prepared workspace ${input.canonicalTargetPath}. Confirm this exact run?`;

  return {
    type: 'warning',
    buttons: ['Cancel', 'Run once'],
    defaultId: 0,
    cancelId: 0,
    title: expertShell ? 'Confirm Expert Shell run' : 'Confirm dangerous agent run',
    message,
  };
}
