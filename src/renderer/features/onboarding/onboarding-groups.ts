import type {
  OnboardingCapabilityStatus,
  OnboardingProviderRow,
  OnboardingRowAction,
} from './onboarding-rows';

/**
 * Step 2 as a grouped list rather than a card per capability.
 *
 * Grouping is a presentation of the §4 matrix, never a second opinion about it:
 * a group is chosen from the row's own settled readouts, and a row with any
 * outstanding probe stays in `checking` so a half-answered row is never filed
 * beside the ones that actually answered.
 *
 * The explanatory sentence a group carries belongs to the group, not to each
 * row: it is written once for "these were found but not confirmed" instead of
 * repeated under every provider.
 */

export type OnboardingGroupKey = 'checking' | 'ready' | 'not-verified' | 'unavailable';

export type OnboardingGroup = {
  readonly key: OnboardingGroupKey;
  /** Short mono heading, as in the reference: CHECKING, READY, … */
  readonly label: string;
  /** Shared explanatory copy, or `null` when the rows speak for themselves. */
  readonly description: string | null;
  readonly rows: readonly OnboardingProviderRow[];
};

const GROUP_LABELS: Readonly<Record<OnboardingGroupKey, string>> = {
  checking: 'Checking',
  ready: 'Ready',
  'not-verified': 'Not verified',
  unavailable: 'Unavailable',
};

const GROUP_DESCRIPTIONS: Readonly<Record<OnboardingGroupKey, string | null>> = {
  checking: 'These checks have not answered yet. Nothing below is ready until it does.',
  ready: null,
  // Deliberately wider than "installed": an account-based provider is also
  // unconfirmed until something establishes that it can actually be used.
  'not-verified':
    'Interleaf found these, but has not confirmed that they can run. Some need a key or a sign-in, so a run is not guaranteed to succeed.',
  unavailable: null,
};

/** Group order, matching the progression a user watches settle. */
const GROUP_ORDER: readonly OnboardingGroupKey[] = ['checking', 'ready', 'not-verified', 'unavailable'];

function capabilities(row: OnboardingProviderRow): readonly OnboardingCapabilityStatus[] {
  return [row.chat, row.agent].filter((item): item is OnboardingCapabilityStatus => item !== null);
}

/**
 * Which group a row belongs to.
 *
 * A pending probe wins over every settled readout on the same row, because a
 * row that is half-checked must not be presented as a finished result.
 */
export function onboardingGroupKey(row: OnboardingProviderRow): OnboardingGroupKey {
  const present = capabilities(row);
  if (present.length === 0) return 'unavailable';
  if (present.some((item) => item.state === 'checking')) return 'checking';
  if (row.tone === 'ready') return 'ready';
  return row.tone === 'attention' ? 'not-verified' : 'unavailable';
}

/** The non-empty groups, in progression order, each with its own row list. */
export function groupOnboardingRows(rows: readonly OnboardingProviderRow[]): readonly OnboardingGroup[] {
  return GROUP_ORDER.flatMap((key) => {
    const matching = rows.filter((row) => onboardingGroupKey(row) === key);
    if (matching.length === 0) return [];
    return [{ key, label: GROUP_LABELS[key], description: GROUP_DESCRIPTIONS[key], rows: matching }];
  });
}

/**
 * One action per row, highest-value first.
 *
 * A row carries at most one affordance because the row's job is to change a
 * decision, not to host a toolbar: the thing that would unblock the row ranks
 * above re-checking, which ranks above a connectivity check on a row that is
 * already ready.
 */
const ACTION_PRIORITY: readonly OnboardingRowAction[] = [
  'add-openrouter-key',
  'sign-in-chatgpt',
  'configure-local-endpoint',
  'retry',
  'install-help',
  'test-connection',
];

export function primaryRowAction(row: OnboardingProviderRow): OnboardingRowAction | null {
  const offered = new Set<OnboardingRowAction>(capabilities(row).flatMap((item) => [...item.actions]));
  return ACTION_PRIORITY.find((action) => offered.has(action)) ?? null;
}

/**
 * The short muted phrase a non-ready row shows beside its name.
 *
 * It is per-row *state*, not the group's shared explanation: an unavailable row
 * says why it cannot be used, and an unconfirmed row names what is missing.
 * Ready and still-checking rows say nothing extra — their pills already do.
 */
export function rowReason(row: OnboardingProviderRow, key: OnboardingGroupKey): string | null {
  if (key === 'ready' || key === 'checking') return null;
  if (key === 'unavailable') {
    const detail = capabilities(row).find((item) => item.detail !== null)?.detail;
    return detail ?? row.statusLabel;
  }
  return row.statusLabel;
}
