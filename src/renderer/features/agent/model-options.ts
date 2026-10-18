/**
 * Options for the Settings "Default model" picker.
 *
 * An empty result means main has no allowlist for the profile — the CLI does not
 * publish one and the user has not listed any — so the editor keeps its free-text
 * field. Otherwise the stored default is kept in the list even when main no
 * longer offers it, so reopening Settings never silently swaps a saved choice for
 * whatever the installed CLI happens to report today.
 */
/**
 * Help text for the per-profile model list. The list is only required for a CLI
 * that publishes no catalog of its own; where main has one, it is a way to pin
 * an extra identifier rather than the sole source of the picker's options.
 */
export function modelListHelpText(availableModels: readonly string[], maxModels: number): string {
  return availableModels.length > 0
    ? `The Agent panel already offers the models known for this CLI, so this list is optional: add an identifier only to pin one that is not offered (up to ${String(maxModels)}).`
    : `These identifiers appear in the Agent panel's model picker. This CLI publishes no model list, so add the ones it accepts (up to ${String(maxModels)}).`;
}

export function mergeDefaultModelOptions(
  availableModels: readonly string[],
  defaultModel: string | null
): readonly string[] {
  if (availableModels.length === 0) return [];
  if (defaultModel === null || availableModels.includes(defaultModel)) return availableModels;
  return [defaultModel, ...availableModels];
}
