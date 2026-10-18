import type { PortableMember } from '../models/portable';

/**
 * Readers for brand-scoped values that were persisted before the Interleaf
 * rename.
 *
 * The application only ever *writes* the Interleaf spelling. Everything here
 * exists so state already on a user's disk — offline article snapshots, agent
 * worktree metadata, agent context packets — keeps loading. Each helper is
 * deliberately narrow: it recognizes one exact legacy token and normalizes it
 * to the current one. There is no general "either brand" matching, and no
 * legacy value is ever produced.
 */

/** Durable article-asset citation written into a snapshot. */
export const ARTICLE_ASSET_REFERENCE_PREFIX = 'interleaf-asset:' as const;
/** Pre-rebrand spelling still present in snapshots captured before the rename. */
const LEGACY_ARTICLE_ASSET_REFERENCE_PREFIX = 'marginlab-asset:' as const;

/** Both spellings a stored snapshot may use for an archived image. */
const ARTICLE_ASSET_REFERENCE_PREFIXES = [
  ARTICLE_ASSET_REFERENCE_PREFIX,
  LEGACY_ARTICLE_ASSET_REFERENCE_PREFIX,
] as const;

/** True when `text` cites at least one archived image, in either spelling. */
export function containsArticleAssetReference(text: string): boolean {
  return ARTICLE_ASSET_REFERENCE_PREFIXES.some((prefix) => text.includes(prefix));
}

/** Provenance tag on a reader selection handed to an agent. */
export const AGENT_CONTEXT_SELECTION_SOURCE = 'interleaf-reader-selection' as const;
/** Pre-rebrand spelling found in agent context packets written before the rename. */
const LEGACY_AGENT_CONTEXT_SELECTION_SOURCE = 'marginlab-reader-selection' as const;

/**
 * Maps a stored agent-context provenance tag to the current spelling.
 * Returns `null` for anything else so an unknown tag stays a validation error
 * rather than being coerced into a trusted value.
 */
export function normalizeLegacyAgentContextSource(
  value: PortableMember,
): typeof AGENT_CONTEXT_SELECTION_SOURCE | null {
  if (value === AGENT_CONTEXT_SELECTION_SOURCE) return AGENT_CONTEXT_SELECTION_SOURCE;
  if (value === LEGACY_AGENT_CONTEXT_SELECTION_SOURCE) return AGENT_CONTEXT_SELECTION_SOURCE;
  return null;
}

/** Git branch an agent environment uses for a session. */
export function agentSessionBranchName(sessionId: string): string {
  return `interleaf/${sessionId}`;
}

/** Branch name used by environments created before the rename. */
export function legacyAgentSessionBranchName(sessionId: string): string {
  return `marginlab/${sessionId}`;
}

/**
 * True when `branchName` is the branch this app created for `sessionId`,
 * accepting the pre-rebrand spelling so an environment recorded before the
 * rename still rehydrates instead of being discarded as untrusted metadata.
 */
export function isAgentSessionBranchName(branchName: PortableMember, sessionId: string): boolean {
  return (
    branchName === agentSessionBranchName(sessionId) ||
    branchName === legacyAgentSessionBranchName(sessionId)
  );
}

/** Staging directory prefix for a session's working copy. */
export const AGENT_STAGE_DIRECTORY_PREFIX = '.interleaf-stage-' as const;
/** Staging directory prefix used before the rename. */
export const LEGACY_AGENT_STAGE_DIRECTORY_PREFIX = '.marginlab-stage-' as const;

/** True when `name` is a staging directory this app owns, in either spelling. */
export function isAgentStageDirectoryName(name: string): boolean {
  return (
    name.startsWith(AGENT_STAGE_DIRECTORY_PREFIX) ||
    name.startsWith(LEGACY_AGENT_STAGE_DIRECTORY_PREFIX)
  );
}
