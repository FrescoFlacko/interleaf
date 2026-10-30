import { InterleafError } from '@shared/errors/interleaf-error';
import type { AppSettings } from '@shared/schemas/settings';
import type { SettingsRepository } from '../db/repositories/settings-repository';
import type { AgentService } from '../agents/agent-service';
import type { UpdateController } from '../updates/update-runtime';

export type SettingsUpdateDeps = {
  readonly settings: Pick<SettingsRepository, 'get' | 'update'>;
  readonly agent: Pick<AgentService, 'assertSettingsUpdateAllowed' | 'applyProfileSettings' | 'validateSavedWorkingDirectorySettings'>;
  readonly updates: Pick<UpdateController, 'setAutomaticChecks'>;
  /** Applies the saved diagnostic-logging preference to the main log sink. */
  readonly applyDiagnosticLogging: (enabled: boolean) => void;
  /** Native confirmation for unsafe profile presets; never answered by the renderer. */
  readonly confirmUnsafeProfile: (profileId: string) => Promise<boolean>;
};

/**
 * Accepts one complete settings document from the renderer.
 *
 * The business rules of a settings write live here rather than in the IPC
 * dispatcher, which only validates and routes:
 *
 * - every saved working-directory handle is revalidated by main first;
 * - a profile newly switched to `unsafe-yolo` needs a native confirmation the
 *   renderer cannot answer, while a profile already stored that way is not
 *   asked about again;
 * - there is one persist path, so every accepted document applies its runtime
 *   effects (agent profiles, diagnostic logging, automatic update checks), and
 *   the agent service can still refuse the write at the last moment.
 */
export async function applySettingsUpdate(next: AppSettings, deps: SettingsUpdateDeps): Promise<AppSettings> {
  const persist = (): AppSettings => {
    deps.agent.assertSettingsUpdateAllowed();
    const saved = deps.settings.update(next);
    deps.agent.applyProfileSettings(saved.agent.profiles);
    deps.applyDiagnosticLogging(saved.advanced.debugLogging);
    deps.updates.setAutomaticChecks(saved.updates.automaticChecks);
    return saved;
  };
  await deps.agent.validateSavedWorkingDirectorySettings(next);
  const unsafeProfile = Object.entries(next.agent.profiles).find(([, profile]) => profile.permissionMode === 'unsafe-yolo')?.[0];
  if (unsafeProfile === undefined || deps.settings.get().agent.profiles[unsafeProfile]?.permissionMode === 'unsafe-yolo') {
    return persist();
  }
  if (!(await deps.confirmUnsafeProfile(unsafeProfile))) {
    throw new InterleafError('validation', 'Unsafe profile changes were cancelled.');
  }
  return persist();
}
