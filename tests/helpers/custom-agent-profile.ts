import { createCustomAgentProfileRequestSchema } from '@shared/schemas/custom-agent-profile';
import type { CustomAgentProfile, CustomAgentProfileCreateInput } from '@shared/types/custom-agent-profile';

/**
 * The stored record main would have written for a create input: every member
 * the panel can read back, with the input's own choices kept and the defaults
 * the input left out filled in, on the branch the input's execution kind
 * selects.
 */
export function storedCustomProfile(input: CustomAgentProfileCreateInput, id: string): CustomAgentProfile {
  const parsed = createCustomAgentProfileRequestSchema.parse(input);
  const now = new Date().toISOString();
  const base = {
    id,
    name: parsed.name,
    executable: { handle: parsed.executableHandle, displayName: 'agent-cli', fingerprint: 'f'.repeat(64) },
    stdoutParsingMode: parsed.stdoutParsingMode,
    defaultModel: parsed.defaultModel,
    reasoningEffort: parsed.reasoningEffort,
    supportsModelSelection: parsed.supportsModelSelection,
    supportsReasoningSelection: parsed.supportsReasoningSelection,
    supportsResume: parsed.supportsResume,
    workingDirectoryPolicy: parsed.workingDirectoryPolicy,
    defaultSandboxMode: parsed.defaultSandboxMode,
    environmentOverrides: parsed.environmentOverrides,
    unsafe: parsed.unsafe,
    createdAt: now,
    updatedAt: now,
  } as const;
  if (parsed.executionKind === 'expert-shell') {
    // The schema's refinement requires both for an expert shell profile.
    if (parsed.shellFamily === undefined || parsed.shellCommand === undefined) throw new Error('expert shell input lacks its shell');
    return {
      ...base,
      executionKind: 'expert-shell',
      shellFamily: parsed.shellFamily,
      shellCommand: parsed.shellCommand,
      resumeShellCommand: parsed.resumeShellCommand,
      promptDeliveryMode: 'stdin',
    };
  }
  if (parsed.argvTemplate === undefined) throw new Error('normal input lacks its argv template');
  return {
    ...base,
    executionKind: 'normal',
    argvTemplate: parsed.argvTemplate,
    promptDeliveryMode: parsed.promptDeliveryMode,
    resumeCommandTemplate: parsed.resumeCommandTemplate,
  };
}
