import type { z } from 'zod';
import type { onboardingLaunchStateSchema } from '../schemas/onboarding';

/**
 * The launch verdict main latched for this process.
 *
 * Deliberately bounded: booleans and enum members only. No probe output, no
 * credential-derived value, no filesystem path and no document text may be
 * added here — this crosses to an untrusted renderer and is also the shape the
 * onboarding settings section mirrors.
 */
export type OnboardingLaunchState = z.output<typeof onboardingLaunchStateSchema>;
