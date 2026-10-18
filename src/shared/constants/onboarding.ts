/**
 * Guided onboarding — shared vocabulary.
 *
 * The stage list is an ordered, fixed contract: persisted progress names the
 * last stage the user actually acted on, and resume is computed from that name
 * rather than from an index, so a stage added or removed later cannot silently
 * reposition an already-saved value.
 */

export const ONBOARDING_STAGES = ['welcome', 'discover', 'connect', 'import', 'first-action'] as const;

export type OnboardingStage = (typeof ONBOARDING_STAGES)[number];

/**
 * Persisted progress states.
 *
 * `finish-later` and `dismissed` both suppress automatic reopening; they are
 * kept apart only so Settings can tell "left partway" from "explicitly done
 * with it". `completed` is the one state that also carries `completedAt`.
 */
export const ONBOARDING_STATUSES = [
  'not-started',
  'in-progress',
  'finish-later',
  'dismissed',
  'completed',
] as const;

export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

/** Shape version of the persisted `onboarding` settings section. */
export const ONBOARDING_SETTINGS_VERSION = 1;

/**
 * What main decided about this launch, latched before the settings document
 * could be initialized or normalized.
 *
 * `new-install` is the only verdict that ever opens the wizard on its own.
 * Every other verdict offers an entry point at most.
 */
export const ONBOARDING_LAUNCH_VERDICTS = [
  'new-install',
  'upgraded-install',
  'not-started',
  'resume',
  'suppressed',
  'done',
] as const;

export type OnboardingLaunchVerdict = (typeof ONBOARDING_LAUNCH_VERDICTS)[number];

/**
 * The stage a resumed flow opens at.
 *
 * `lastStageAcknowledged` names the last stage the user completed an action on,
 * so resuming opens the one after it. A `null` value, or a name this build no
 * longer has, resumes at Welcome rather than failing.
 */
export function resolveResumeStage(lastStageAcknowledged: string | null): OnboardingStage {
  if (lastStageAcknowledged === null) return 'welcome';
  const index = (ONBOARDING_STAGES as readonly string[]).indexOf(lastStageAcknowledged);
  if (index < 0) return 'welcome';
  return ONBOARDING_STAGES[index + 1] ?? ONBOARDING_STAGES[ONBOARDING_STAGES.length - 1] ?? 'welcome';
}

/** Whether a verdict means the wizard may open without the user asking. */
export function shouldAutoOpenOnboarding(verdict: OnboardingLaunchVerdict): boolean {
  return verdict === 'new-install' || verdict === 'resume';
}
