/**
 * Ordering rule for a profile's model identifiers, kept separate from the
 * validating resolver in `agent-models.ts` so that adding a source (the CLI's
 * own listing, most recently) is a change to this one pure function.
 *
 * The result is unvalidated and may contain duplicates: `resolveAgentModelOptions`
 * is the only caller and applies the identifier guard and de-duplication.
 * Precedence is deliberate — the configured default is always first, the user's
 * curated list stays ahead of anything discovered from the installed CLI, and
 * repo-evidenced seeds come last.
 */
export function agentModelCandidates(
  defaultModel: string | null,
  configuredModels: readonly string[] | undefined,
  discoveredModels: readonly string[] | undefined,
  seededModels: readonly string[]
): readonly string[] {
  return [
    ...(defaultModel === null ? [] : [defaultModel]),
    ...(configuredModels ?? []),
    ...(discoveredModels ?? []),
    ...seededModels,
  ];
}
