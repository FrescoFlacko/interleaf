import { isLibraryModalOpen, useLibraryStore } from '../stores/use-library-store';
import { useUiStore } from '../stores/use-ui-store';
import { useOnboardingOwnsScreen } from '../features/onboarding/OnboardingHost';

/**
 * Which parts of the shell are covered by something modal.
 *
 * Every surface that takes over the screen has to inert the shell behind it, or
 * a screen reader and the Tab order keep reaching content the user cannot see.
 * Collecting that question here keeps one answer for all of them: a new modal
 * surface is added to this list and is then handled everywhere, instead of
 * being threaded through `App` as one more boolean in two long chains.
 *
 * The compact drawers are deliberately treated differently from the rest. They
 * cover the reader, so the background goes inert with them, but the drawers
 * themselves must stay operable — which is why the two answers are separate.
 */
export type ShellInertState = {
  /** The main shell: inert behind any modal surface, and behind a drawer. */
  readonly backgroundInert: boolean;
  /** The compact drawers: inert behind a modal, but not behind each other. */
  readonly drawerInert: boolean;
};

export function useShellInertState(compactPresentation: boolean): ShellInertState {
  const shortcutsOpen = useUiStore((state) => state.shortcutsOpen);
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  const compactActivePanel = useUiStore((state) => state.compactActivePanel);
  const libraryModalOpen = useLibraryStore(isLibraryModalOpen);
  const onboardingOpen = useOnboardingOwnsScreen();

  const modalOpen = shortcutsOpen || libraryModalOpen || settingsOpen || onboardingOpen;
  return {
    backgroundInert: modalOpen || (compactPresentation && compactActivePanel !== null),
    drawerInert: modalOpen,
  };
}
