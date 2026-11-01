import { useEffect, type ReactElement } from 'react';
import { selectWebImportModalOpen, useLibraryStore } from '../../stores/use-library-store';
import { selectSettingsHydrated, useUiStore } from '../../stores/use-ui-store';
import { useOnboardingStore } from '../../stores/use-onboarding-store';
import { OnboardingWizard } from './OnboardingWizard';
import { FirstActionTip } from './FirstActionTip';
import { OnboardingEntryBanner } from './OnboardingEntryBanner';

/**
 * Mounts guided onboarding beside the shell.
 *
 * Two responsibilities beyond rendering:
 *
 * - It asks main for the launch verdict once settings have hydrated, so the
 *   wizard's own persisted progress is known before it can open. The verdict
 *   itself was latched in main long before this point.
 * - It **yields** rather than stacking. Adding an OpenRouter key or saving a web
 *   article reuses the existing Settings and import dialogs verbatim; while one
 *   of those is up the wizard stops rendering and its state is untouched, so the
 *   user is never inside two modals at once and returns to the same stage.
 */
export function OnboardingHost(): ReactElement | null {
  const hydrated = useUiStore(selectSettingsHydrated);
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  const webImportOpen = useLibraryStore(selectWebImportModalOpen);
  const initialize = useOnboardingStore((state) => state.initialize);
  const initialized = useOnboardingStore((state) => state.launchState !== null);

  useEffect(() => {
    if (!hydrated || initialized) return;
    void initialize();
  }, [hydrated, initialize, initialized]);

  const yielded = settingsOpen || webImportOpen;

  return (
    <>
      {!yielded && <OnboardingWizard />}
      {!yielded && <OnboardingEntryBanner />}
      <FirstActionTip />
    </>
  );
}

/** Whether the shell should be inert because the wizard owns the screen. */
export function useOnboardingOwnsScreen(): boolean {
  const open = useOnboardingStore((state) => state.open);
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  const webImportOpen = useLibraryStore(selectWebImportModalOpen);
  return open && !settingsOpen && !webImportOpen;
}
