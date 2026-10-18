export const AGENT_EXECUTION_MODES = [
  'auto-isolated',
  'isolated-worktree',
  'isolated-copy',
  'native-restricted',
  'container-sandbox',
  'active-env',
] as const;

export type AgentExecutionMode = (typeof AGENT_EXECUTION_MODES)[number];

/** Modes that may be stored as a normal preference. Direct active-tree writes
 * are deliberately session-only and can never become a persisted default. */
export const AGENT_DEFAULT_EXECUTION_MODES = [
  'auto-isolated',
  'isolated-worktree',
  'isolated-copy',
  'container-sandbox',
] as const;

export type AgentDefaultExecutionMode = (typeof AGENT_DEFAULT_EXECUTION_MODES)[number];

export const RESOLVED_AGENT_EXECUTION_MODES = [
  'isolated-worktree',
  'isolated-copy',
  'native-restricted',
  'container-sandbox',
  'active-env',
] as const;

export type ResolvedAgentExecutionMode = (typeof RESOLVED_AGENT_EXECUTION_MODES)[number];

export type AgentRiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** The single main-owned risk predicate (docs/REMAINING_WORK.md item N),
 * re-exported here so mode and risk are read from one place. */
export { resolveAgentRiskLevel } from './agent-risk';

export type AgentExecutionModeInfo = { readonly id: AgentExecutionMode;
readonly label: string;
readonly description: string;
readonly riskLevel: AgentRiskLevel;
readonly riskSummary: string;
/**
 * True when the mode must never be selected silently: the UI has to surface
 * an explicit, deliberate confirmation step (ADR-0008).
 */
readonly requiresExplicitConfirmation: boolean; }

/**
 * Execution-mode taxonomy and defaults from ADR-0008:
 * - Git repositories default to Isolated Worktree.
 * - Non-Git directories automatically use Isolated Directory Copy.
 * - Active Environment is deliberate-selection-only with HIGH/CRITICAL warning.
 */
export const AGENT_EXECUTION_MODE_INFO: Readonly<
  Record<AgentExecutionMode, AgentExecutionModeInfo>
> = {
  'auto-isolated': {
    id: 'auto-isolated',
    label: 'Auto-Isolated (Recommended)',
    description:
      'Interleaf picks the isolation for you: an Isolated Worktree for a Git repository, or an Isolated Directory Copy for any other folder.',
    riskLevel: 'medium',
    riskSummary: 'Automatic workspace isolation — your project files stay untouched until reviewed.',
    requiresExplicitConfirmation: false,
  },
  'isolated-worktree': {
    id: 'isolated-worktree',
    label: 'Isolated Worktree',
    description:
      'Runs the agent in a temporary git worktree under Interleaf-managed storage. Your repository stays clean until you review and apply the diff.',
    riskLevel: 'medium',
    riskSummary: 'Isolated workspace — changes stay out of your working tree until applied.',
    requiresExplicitConfirmation: false,
  },
  'isolated-copy': {
    id: 'isolated-copy',
    label: 'Isolated Directory Copy',
    description:
      'For non-Git directories: copies the project to a managed sandbox, runs there, and computes a delta for review.',
    riskLevel: 'medium',
    riskSummary: 'Isolated copy — your original directory is untouched until changes are applied.',
    requiresExplicitConfirmation: false,
  },
  'native-restricted': {
    id: 'native-restricted',
    label: 'Native Restricted',
    description:
      'Uses the agent CLI’s own restricted permission mode (e.g. Codex workspace-write) against the selected directory.',
    riskLevel: 'medium',
    riskSummary: 'Restricted by the agent’s built-in permission system.',
    requiresExplicitConfirmation: true,
  },
  'container-sandbox': {
    id: 'container-sandbox',
    label: 'Container Sandbox',
    description:
      'Executes inside a bounded rootless container with mounted workspace only. Requires Docker/Podman.',
    riskLevel: 'low',
    riskSummary: 'Strongest isolation — bounded container with no host home access.',
    requiresExplicitConfirmation: false,
  },
  'active-env': {
    id: 'active-env',
    label: 'Active Environment',
    description:
      'Runs the agent directly in the selected working directory with write access. Nothing is isolated.',
    riskLevel: 'high',
    riskSummary: 'The agent may modify the selected working directory directly. Changes are not automatically isolated.',
    requiresExplicitConfirmation: true,
  },
};

/** ADR-0008: Auto-Isolated is the persisted default preference resolved in main. */
export const DEFAULT_AGENT_EXECUTION_MODE: AgentDefaultExecutionMode = 'auto-isolated';
