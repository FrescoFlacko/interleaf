import { describe, expect, it } from 'vitest';
import {
  appSettingsSchema,
  DEFAULT_APP_SETTINGS,
  onboardingSettingsSchema,
} from '@shared/schemas/settings';
import {
  ONBOARDING_STAGES,
  resolveResumeStage,
  shouldAutoOpenOnboarding,
} from '@shared/constants/onboarding';
import type { PortableRecordDraft } from '@shared/models/portable';

/**
 * The onboarding section has to be additive in the strict sense: a settings
 * document written before it existed must still load with every other
 * preference intact. These assertions are what stop a later edit from making
 * the section required and silently resetting an existing user's settings.
 */
describe('onboarding settings contract', () => {
  it('defaults the section when a stored document predates it', () => {
    const stored = { ...DEFAULT_APP_SETTINGS } as PortableRecordDraft;
    delete stored.onboarding;
    stored.appearance = { palette: 'midnight' };

    const parsed = appSettingsSchema.parse(stored);

    expect(parsed.onboarding).toEqual({
      version: 1,
      status: 'not-started',
      lastStageAcknowledged: null,
      completedAt: null,
    });
    // Nothing else was reset by the added section.
    expect(parsed.appearance.palette).toBe('midnight');
  });

  it('defaults the new chat and agent defaults to "no preference"', () => {
    const stored = { ...DEFAULT_APP_SETTINGS } as PortableRecordDraft;
    stored.ai = { openRouterModel: 'openrouter/auto' };
    stored.agent = { defaultExecutionMode: 'auto-isolated' };

    const parsed = appSettingsSchema.parse(stored);

    expect(parsed.ai.defaultChat).toBeNull();
    expect(parsed.agent.defaultProfileId).toBeNull();
  });

  it('accepts an explicitly chosen chat default and a built-in agent default', () => {
    const parsed = appSettingsSchema.parse({
      ...DEFAULT_APP_SETTINGS,
      ai: { ...DEFAULT_APP_SETTINGS.ai, defaultChat: { providerId: 'claude', modelId: null } },
      agent: { ...DEFAULT_APP_SETTINGS.agent, defaultProfileId: 'codex' },
    });

    expect(parsed.ai.defaultChat).toEqual({ providerId: 'claude', modelId: null });
    expect(parsed.agent.defaultProfileId).toBe('codex');
  });

  it('refuses an agent default that is not a built-in profile', () => {
    const result = appSettingsSchema.safeParse({
      ...DEFAULT_APP_SETTINGS,
      agent: { ...DEFAULT_APP_SETTINGS.agent, defaultProfileId: 'custom-anything' },
    });

    expect(result.success).toBe(false);
  });

  it('refuses anything beyond the four bounded progress fields', () => {
    // A probe log, an executable path or a provider error body must not be
    // storable here, so the section is closed rather than passthrough.
    const result = onboardingSettingsSchema.safeParse({
      version: 1,
      status: 'in-progress',
      lastStageAcknowledged: 'discover',
      completedAt: null,
      lastProbeOutput: '/usr/local/bin/codex --version',
    });

    expect(result.success).toBe(false);
  });

  it('refuses a stage name it does not define', () => {
    expect(onboardingSettingsSchema.safeParse({ lastStageAcknowledged: 'billing' }).success).toBe(false);
  });
});

describe('onboarding resume mapping', () => {
  it('resumes at welcome when nothing was acknowledged', () => {
    expect(resolveResumeStage(null)).toBe('welcome');
  });

  it('opens the stage after the one the user acted on', () => {
    expect(resolveResumeStage('welcome')).toBe('discover');
    expect(resolveResumeStage('import')).toBe('first-action');
  });

  it('stays on the last stage when it was the one acknowledged', () => {
    expect(resolveResumeStage('first-action')).toBe('first-action');
  });

  it('falls back to welcome for a stage this build no longer has', () => {
    expect(resolveResumeStage('a-stage-from-a-later-version')).toBe('welcome');
  });

  it('covers every declared stage without throwing', () => {
    for (const stage of ONBOARDING_STAGES) {
      expect(ONBOARDING_STAGES).toContain(resolveResumeStage(stage));
    }
  });

  it('auto-opens only for a genuinely new install or an interrupted flow', () => {
    expect(shouldAutoOpenOnboarding('new-install')).toBe(true);
    expect(shouldAutoOpenOnboarding('resume')).toBe(true);
    expect(shouldAutoOpenOnboarding('upgraded-install')).toBe(false);
    expect(shouldAutoOpenOnboarding('not-started')).toBe(false);
    expect(shouldAutoOpenOnboarding('suppressed')).toBe(false);
    expect(shouldAutoOpenOnboarding('done')).toBe(false);
  });
});
