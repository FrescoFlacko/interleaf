/**
 * The single risk predicate (docs/REMAINING_WORK.md item N). Mode resolution,
 * native confirmation, environment persistence, and every UI or accessibility
 * label must derive from this function, so a renderer-supplied label can never
 * present a lower level than main computed.
 */
import type { AgentExecutionMode, AgentRiskLevel } from './agent-modes';

export type AgentRiskInput = {
  readonly mode: AgentExecutionMode;
  /**
   * Expert Shell or an unsafe profile: the process runs with the user's full
   * OS authority, which no workspace isolation reduces.
   */
  readonly dangerousProfile: boolean;
  /** A renderer-configured custom profile whose executable/argv are untrusted. */
  readonly unverifiedProfile?: boolean;
};

export function resolveAgentRiskLevel(input: AgentRiskInput): AgentRiskLevel {
  if (input.dangerousProfile) {
    // No verified container runtime exists, so a dangerous profile is always critical.
    return 'critical';
  }
  if (input.unverifiedProfile === true) return 'high';
  if (input.mode === 'active-env') return 'high';
  if (input.mode === 'container-sandbox') return 'low';
  return 'medium';
}
