/**
 * Reader Chat reasoning-effort vocabulary.
 *
 * One portable list for every provider, so the session row, the IPC contract
 * and the picker agree on what a stored value can be. A provider only ever
 * offers the subset its own metadata advertises for a model; nothing here says
 * any model supports any level.
 *
 * The values keep real transport distinctions rather than collapsing them:
 * - `off` is Pi/Omp `--thinking off`, and the Off half of an Ollama on/off
 *   control (sent as `none`, which Ollama documents as "no thinking");
 * - `none` is the OpenRouter/Codex effort of that name;
 * - `on` is the On half of an Ollama on/off control.
 *
 * The order is display order, quietest first.
 */
export const REASONING_EFFORTS = ['off', 'none', 'on', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Longest level list a model can advertise: the whole vocabulary, once each. */
export const REASONING_MAX_LEVELS = REASONING_EFFORTS.length;

const EFFORT_SET: ReadonlySet<string> = new Set(REASONING_EFFORTS);

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return EFFORT_SET.has(value);
}

/**
 * The advertised levels as a canonical list: vocabulary members only, each
 * once, in display order. Untrusted provider metadata goes through this, so an
 * unknown, duplicated or oddly ordered value can never reach a session row.
 */
export function canonicalReasoningLevels(values: Iterable<string>): readonly ReasoningEffort[] {
  const offered = new Set<string>();
  for (const value of values) offered.add(value);
  return REASONING_EFFORTS.filter((effort) => offered.has(effort));
}

/** Short, fixed display names; never derived from provider text. */
export const REASONING_EFFORT_LABELS: Readonly<Record<ReasoningEffort, string>> = {
  off: 'Off',
  none: 'None',
  on: 'On',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Xhigh',
  max: 'Max',
};
