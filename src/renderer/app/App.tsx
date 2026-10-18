import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppHeader } from "../components/AppHeader";
import { CompanionPanel } from "../components/CompanionPanel";
import { LibrarySidebar } from "../components/LibrarySidebar";
import { ReaderViewport } from "../components/ReaderViewport";
import { ShortcutsDialog } from "../components/ShortcutsDialog";
import { useSlidePresence } from "../components/slide-presence";
import { bridge, loadInitialSettings, persistSettings } from "./api-client";
import { useShortcuts } from "../hooks/use-shortcuts";
import { takeFocusModeReturnElement, useUiStore } from "../stores/use-ui-store";
import { useLibraryStore } from "../stores/use-library-store";
import { isReaderReady, useReaderStore } from "../stores/use-reader-store";
import { ChatStoreContext } from "../stores/use-chat-store";
import { useOwnedChatStore } from "../stores/use-owned-chat-store";
import { AIProviderSettingsModal, DIALOG_EXIT_MS } from "../features/chat/AIProviderSettingsModal";
import { LibraryModalHost } from "../features/library/components/LibraryModalHost";
import { OnboardingHost } from "../features/onboarding/OnboardingHost";
import { useShellInertState } from "./use-shell-inert-state";
import { ResizablePanel } from "../components/ResizablePanel";
import { CompactDrawer } from "../components/CompactDrawer";
import { OpenFileNotice } from "../components/OpenFileNotice";
import { followFileCommands } from "../stores/use-open-file-store";
import { useAppliedPalette } from "../styles/use-applied-palette";
export function App() {
  // The one chat controller this window runs, shared by every view below and
  // disposed when the app unmounts.
  const chatStore = useOwnedChatStore();
  const [compactPresentation, setCompactPresentation] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 920
  );
  const palette = useUiStore((state) => state.palette);
  const leftOpen = useUiStore((state) => state.leftOpen);
  const rightOpen = useUiStore((state) => state.rightOpen);
  const leftWidth = useUiStore((state) => state.leftWidth);
  const rightWidth = useUiStore((state) => state.rightWidth);
  const setLeftWidth = useUiStore((state) => state.setLeftWidth);
  const setRightWidth = useUiStore((state) => state.setRightWidth);
  const focusMode = useUiStore((state) => state.focusMode);
  const readerReady = useReaderStore(isReaderReady);
  const compactActivePanel = useUiStore((state) => state.compactActivePanel);
  const shortcutsOpen = useUiStore((state) => state.shortcutsOpen);
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  const settingsTarget = useUiStore((state) => state.settingsTarget);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);
  const hydrate = useUiStore((state) => state.hydrate);
  const loadedSettings = useUiStore((state) => state.loadedSettings);
  const setLoadedSettings = useUiStore((state) => state.setLoadedSettings);
  const previousFocusMode = useRef(false);
  const lastPanelPreference = useRef<{ leftOpen: boolean; rightOpen: boolean } | null>(null);
  const { backgroundInert, drawerInert } = useShellInertState(compactPresentation);
  // Presence managers run unconditionally at the top level (rules of hooks);
  // they keep an exiting drawer mounted through its slide-out transition.
  const leftDrawerPresence = useSlidePresence(compactActivePanel === 'left');
  const rightDrawerPresence = useSlidePresence(compactActivePanel === 'right');
  // The dialog only exists while it is wanted, plus its own exit transition.
  const settingsPresence = useSlidePresence(settingsOpen, DIALOG_EXIT_MS);
  const previousCompactPanelRef = useRef<'left' | 'right' | null>(compactActivePanel);
  useEffect(() => {
    const previous = previousCompactPanelRef.current;
    previousCompactPanelRef.current = compactActivePanel;
    if (previous !== null && compactActivePanel === null) {
      // Close started (Escape / backdrop / Close button): hand focus to the
      // owning header toggle NOW, on the exiting commit — never after unmount.
      document.querySelector<HTMLElement>(`[data-testid="toggle-${previous}-panel"]`)?.focus();
    }
    // Switching straight to the other drawer keeps focus flowing into the
    // replacement drawer instead of yanking it back to a toggle button.
  }, [compactActivePanel]);

  useEffect(() => {
    const updatePresentation = (): void => {
      // The 420px reader minimum plus both panel minima is 920px. This is a
      // transient presentation policy: preference state remains untouched and
      // returns automatically when the window has room again.
      setCompactPresentation(window.innerWidth < 920);
    };
    updatePresentation();
    window.addEventListener('resize', updatePresentation);
    return () => { window.removeEventListener('resize', updatePresentation); };
  }, []);

  // Leaving the compact presentation while a drawer is open closes it
  // synchronously: its header toggle is still a valid focus target at that
  // moment (pre-paint), focus never falls to <body>, and shrinking the window
  // again cannot resurrect a stale drawer.
  const previousCompactRef = useRef(compactPresentation);
  useLayoutEffect(() => {
    const wasCompact = previousCompactRef.current;
    previousCompactRef.current = compactPresentation;
    if (wasCompact && !compactPresentation) {
      useUiStore.getState().setCompactActivePanel(null);
    }
  }, [compactPresentation]);


  useEffect(() => {
    void loadInitialSettings().then((settings) => {
      if (settings) {
        hydrate(settings);
        useReaderStore.getState().hydrateReaderAppearance(settings.reader);
        // Hydration lands after the shell is interactive, so saved Library
        // defaults yield to a view or sort the reader already chose.
        useLibraryStore.getState().applyLibraryDefaults(settings.library);
      }
    });
  }, [hydrate]);

  // The File menu and operating-system open requests arrive as commands.
  useEffect(() => followFileCommands(), []);

  useEffect(() => {
    return bridge.app.onBeforeClose(() =>
      useReaderStore.getState().flushPendingReadingPosition()
    );
  }, []);

  useAppliedPalette(palette, loadedSettings !== null);

  // Collapse state is a normal workspace preference. Focus Mode deliberately
  // skips this effect so its temporary false/false state is never persisted.
  useEffect(() => {
    if (focusMode || !loadedSettings) return;
    const current = { leftOpen, rightOpen };
    const previous = lastPanelPreference.current;
    lastPanelPreference.current = current;
    if (previous?.leftOpen === current.leftOpen && previous.rightOpen === current.rightOpen) return;
    const next = { ...loadedSettings, layout: { ...loadedSettings.layout, ...current } };
    setLoadedSettings(next);
    persistSettings(next);
  }, [focusMode, leftOpen, loadedSettings, rightOpen, setLoadedSettings]);

  useEffect(() => {
    const wasFocused = previousFocusMode.current;
    previousFocusMode.current = focusMode;
    const animationFrame = window.requestAnimationFrame(() => {
      if (focusMode) {
        document.querySelector<HTMLElement>("[data-testid='reader-viewport']")?.focus();
      } else if (wasFocused) {
        const returnTarget = takeFocusModeReturnElement();
        if (returnTarget?.isConnected) {
          returnTarget.focus();
        } else {
          document.querySelector<HTMLElement>("[data-testid='reader-focus-button']")?.focus();
        }
      }
    });
    return () => { window.cancelAnimationFrame(animationFrame); };
  }, [focusMode]);

  // Closing a document or an adapter failure can invalidate the reader while
  // Focus Mode is still true. Exit immediately so the hidden-shell layout
  // cannot persist over Library or a failed reader workspace.
  useEffect(() => {
    if (focusMode && !readerReady) {
      useUiStore.getState().toggleFocusMode(false);
    }
  }, [focusMode, readerReady]);

  useShortcuts();

  return (
    <ChatStoreContext.Provider value={chatStore}>
      <div
        data-app-shell
        data-testid="app-shell"
        inert={backgroundInert}
        aria-hidden={backgroundInert ? true : undefined}
        className="flex h-full flex-col min-w-0 max-w-full overflow-x-hidden"
      >
        <a
          href="#main-content"
          data-testid="skip-to-reader"
          onClick={() => {
            const target = document.getElementById('main-content');
            if (target) {
              target.focus();
            }
          }}
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-bg-primary focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-text-primary focus:shadow-lg focus:ring-2 focus:ring-focus-ring"
        >
          Skip to main content
        </a>
        <div style={{ display: focusMode ? "none" : "contents" }}>
          <AppHeader compact={compactPresentation} />
          <OpenFileNotice />
        </div>
        <div className="flex min-h-0 flex-1">
          {!compactPresentation && (
            <ResizablePanel
              side="left"
              width={leftWidth}
              otherOpenWidth={rightOpen ? rightWidth : 0}
              onWidthChange={setLeftWidth}
              open={!focusMode && leftOpen}
            >
              <LibrarySidebar />
            </ResizablePanel>
          )}
          <ReaderViewport />
          {!compactPresentation && (
            <ResizablePanel
              side="right"
              width={rightWidth}
              otherOpenWidth={leftOpen ? leftWidth : 0}
              onWidthChange={setRightWidth}
              open={!focusMode && rightOpen}
            >
              <CompanionPanel />
            </ResizablePanel>
          )}
        </div>
      </div>
      {compactPresentation && (leftDrawerPresence.present || rightDrawerPresence.present) && (
        <>
          <div
            data-testid="compact-backdrop"
            onClick={() => { useUiStore.getState().setCompactActivePanel(null); }}
            className={`fixed inset-0 z-30 bg-black/40 transition-opacity duration-(--dur-slow) ease-(--ease-drawer) ${compactActivePanel !== null ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          />
          {leftDrawerPresence.present && (
            <CompactDrawer
              side="left"
              label="Library"
              testId="compact-drawer-left"
              slidePhase={leftDrawerPresence.phase}
              inert={drawerInert || compactActivePanel !== 'left'}
              onClose={() => { useUiStore.getState().setCompactActivePanel(null); }}
              onSwitch={() => { useUiStore.getState().setCompactActivePanel('right'); }}
              switchLabel="Switch to companion panel"
              switchTestId="switch-to-companion-button"
            >
              <LibrarySidebar />
            </CompactDrawer>
          )}
          {rightDrawerPresence.present && (
            <CompactDrawer
              side="right"
              label="Companion"
              testId="compact-drawer-right"
              slidePhase={rightDrawerPresence.phase}
              inert={drawerInert || compactActivePanel !== 'right'}
              onClose={() => { useUiStore.getState().setCompactActivePanel(null); }}
              onSwitch={() => { useUiStore.getState().setCompactActivePanel('left'); }}
              switchLabel="Switch to library sidebar"
              switchTestId="switch-to-library-button"
            >
              <CompanionPanel />
            </CompactDrawer>
          )}
        </>
      )}
      {/* Sibling of the shell, never inert: library modal state is what inerts
          the shell, so the dialog it refers to must live outside it. */}
      <LibraryModalHost />
      {/* Also a never-inert sibling: the wizard is what inerts the shell, and
          the first-action tip must stay usable beside a live document. */}
      <OnboardingHost />
      <ShortcutsDialog open={shortcutsOpen} />
      {settingsPresence.present && (
        <AIProviderSettingsModal
          open={settingsOpen}
          initialTarget={settingsTarget}
          onClose={() => { setSettingsOpen(false); }}
          onProvidersChanged={() => {
            void chatStore.getState().refreshProviders();
          }}
        />
      )}
    </ChatStoreContext.Provider>
  );
}
