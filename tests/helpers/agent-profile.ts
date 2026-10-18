import type { AgentProfile, AgentProviderId } from '@shared/types/agent';

/**
 * A complete built-in agent profile as main reports it, for a test that only
 * cares about its identity and whether it offers reasoning selection.
 */
export function testAgentProfile(
  id: AgentProviderId,
  name: string,
  { reasoningSelection = false }: { readonly reasoningSelection?: boolean } = {},
): AgentProfile {
  return {
    id,
    providerId: id,
    name,
    defaultModel: null,
    availableModels: [],
    reasoningEffort: null,
    defaultSandboxMode: 'auto-isolated',
    capabilities: {
      structuredOutput: true, sessionResume: true, nativeSandbox: false, workingDirectory: true,
      modelSelection: false, reasoningSelection, fileChangeEvents: true, toolEvents: true,
      subagents: false, interactiveAuthentication: false, nonInteractiveMode: true,
    },
    detection: { availability: 'installed', version: 'test', checkedAt: '2026-01-01T00:00:00.000Z', errorMessage: null },
    isCustom: false,
    unsafe: false,
  };
}
