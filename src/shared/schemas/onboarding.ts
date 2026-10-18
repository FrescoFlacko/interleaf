import { z } from 'zod';
import {
  ONBOARDING_LAUNCH_VERDICTS,
  ONBOARDING_STAGES,
} from '../constants/onboarding';

/**
 * Result contract for `onboarding:get-launch-state`.
 *
 * The channel takes no payload, so this exists for the preload side: the bridge
 * validates what main returned before handing it to the renderer, and the shape
 * is closed so a future main-side field cannot reach the renderer unreviewed.
 */
export const onboardingLaunchStateSchema = z.object({
  verdict: z.enum(ONBOARDING_LAUNCH_VERDICTS),
  /** True only where the wizard may open without the user asking for it. */
  shouldAutoOpen: z.boolean(),
  /** Where a resumed or first-time flow starts. */
  resumeStage: z.enum(ONBOARDING_STAGES),
  /** Whether a settings row existed before this process read settings. */
  settingsRowPresent: z.boolean(),
  /** Whether that row already carried an `onboarding` section. */
  onboardingSectionPresent: z.boolean(),
  /**
   * Whether main found bounded evidence that this install predates the launch
   * (prior migrations, existing user rows, or the legacy-profile adoption
   * decision). An empty library alone never sets this.
   */
  priorInstallEvidence: z.boolean(),
}).strict();
