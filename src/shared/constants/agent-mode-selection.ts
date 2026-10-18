import type { AgentExecutionMode } from './agent-modes';

/**
 * The execution modes the UI may offer, separate from the vocabularies main,
 * the settings schema and the database still accept.
 *
 * `container-sandbox` is deliberately absent: no verified rootless bounded
 * executor exists (ADR-0008), so main always resolves it fail-closed. It stays
 * in `AGENT_EXECUTION_MODES` and `AGENT_DEFAULT_EXECUTION_MODES` so previously
 * persisted rows, settings documents and custom profiles keep validating and
 * keep failing closed, rather than being silently rewritten or rejected.
 */
export const AGENT_SELECTABLE_EXECUTION_MODES = [
  'auto-isolated',
  'isolated-worktree',
  'isolated-copy',
  'native-restricted',
  'active-env',
] as const;

export type SelectableAgentExecutionMode = (typeof AGENT_SELECTABLE_EXECUTION_MODES)[number];

/** Persistable defaults the UI may offer. See `AGENT_SELECTABLE_EXECUTION_MODES`. */
export const AGENT_SELECTABLE_DEFAULT_EXECUTION_MODES = [
  'auto-isolated',
  'isolated-worktree',
  'isolated-copy',
] as const;

export type SelectableAgentDefaultExecutionMode = (typeof AGENT_SELECTABLE_DEFAULT_EXECUTION_MODES)[number];

/** ADR-0008: Auto-Isolated is the recommended default the UI falls back to. */
export const DEFAULT_SELECTABLE_EXECUTION_MODE: SelectableAgentDefaultExecutionMode = 'auto-isolated';

/**
 * Maps a stored mode onto a mode the UI can display, without rewriting what is
 * persisted. A legacy `container-sandbox` value stays in storage and stays
 * fail-closed in main; the surfaces that must render a choice fall back to the
 * recommended default instead of showing an option that can never run.
 */
export function toSelectableExecutionMode(mode: AgentExecutionMode): SelectableAgentExecutionMode {
  return isSelectableExecutionMode(mode) ? mode : DEFAULT_SELECTABLE_EXECUTION_MODE;
}

/** Default-preference counterpart of `toSelectableExecutionMode`. */
export function toSelectableDefaultExecutionMode(mode: AgentExecutionMode): SelectableAgentDefaultExecutionMode {
  return isSelectableDefaultExecutionMode(mode) ? mode : DEFAULT_SELECTABLE_EXECUTION_MODE;
}

function isSelectableExecutionMode(mode: AgentExecutionMode): mode is SelectableAgentExecutionMode {
  return (AGENT_SELECTABLE_EXECUTION_MODES as readonly AgentExecutionMode[]).includes(mode);
}

function isSelectableDefaultExecutionMode(mode: AgentExecutionMode): mode is SelectableAgentDefaultExecutionMode {
  return (AGENT_SELECTABLE_DEFAULT_EXECUTION_MODES as readonly AgentExecutionMode[]).includes(mode);
}
