import type { AppSettings } from '@shared/schemas/settings';
import { selectSettingsHydrated, useUiStore } from '../../stores/use-ui-store';
import { useReaderStore } from '../../stores/use-reader-store';
import { useLibraryStore } from '../../stores/use-library-store';
import { useAgentStore } from '../../stores/use-agent-store';

/**
 * Panel layout is owned by the live workspace, not by this modal's loaded
 * settings snapshot. Layout persistence is asynchronous, so `settings.get`
 * can answer with a document written before the newest resize/collapse, and
 * every settings write from this modal sends a complete `AppSettings`
 * document. Re-reading the live layout at snapshot and write time keeps a
 * stale read from resizing the workspace or from being persisted back over
 * newer widths.
 *
 * Focus Mode's temporarily collapsed panels are never a persisted preference
 * (see `App.tsx`), so its pre-focus snapshot supplies the open state while it
 * is active. Before hydration the store still holds defaults, so the loaded
 * document is authoritative and is returned unchanged.
 */
export function withLiveLayout(settings: AppSettings): AppSettings {
  const ui = useUiStore.getState();
  if (!selectSettingsHydrated(ui)) return settings;
  const preference = ui.focusMode ? ui.focusSnapshot : null;
  return {
    ...settings,
    layout: {
      ...settings.layout,
      leftWidth: preference?.leftWidth ?? ui.leftWidth,
      rightWidth: preference?.rightWidth ?? ui.rightWidth,
      leftOpen: preference?.leftOpen ?? ui.leftOpen,
      rightOpen: preference?.rightOpen ?? ui.rightOpen,
    },
  };
}

/**
 * Hands a freshly read settings document to the stores.
 *
 * Hydration is bootstrap recovery only. Re-hydrating an already hydrated store
 * from this load would reset live panel widths, panel open state, palette, and
 * the composer execution mode to whatever this (possibly stale) settings
 * document happens to contain — opening or reloading Settings must never
 * resize or reset the workspace.
 */
export function hydrateStoresFromLoad(read: AppSettings, withLayout: AppSettings): void {
  const ui = useUiStore.getState();
  if (selectSettingsHydrated(ui)) ui.setLoadedSettings(withLayout);
  else ui.hydrate(read);
  useReaderStore.getState().hydrateReaderAppearance(read.reader);
}

/** Shows an optimistic edit in the stores before main has confirmed it. */
export function showOptimisticSettings(optimistic: AppSettings): void {
  const ui = useUiStore.getState();
  ui.setLoadedSettings(optimistic);
  if (optimistic.appearance.palette !== ui.palette) ui.setPalette(optimistic.appearance.palette);
}

/**
 * Applies what one confirmed write changed to the stores that act on it.
 *
 * Changing a Library default here is a deliberate choice, so it takes effect at
 * once rather than waiting for the next launch. A default this save left alone
 * must not disturb a view or sort chosen while browsing. The agent store
 * re-reads its working directories and profiles only after main validated the
 * document.
 */
export function syncStoresAfterConfirmedWrite(validated: AppSettings, previous: AppSettings): void {
  useLibraryStore.getState().applyLibraryDefaults(validated.library, {
    view: validated.library.defaultView !== previous.library.defaultView,
    sort: validated.library.defaultSort !== previous.library.defaultSort,
  });
  void (async () => {
    await useAgentStore.getState().syncWorkingDirectorySettings(validated);
    await useAgentStore.getState().refreshProfiles();
  })();
}

/**
 * A changed endpoint, mode or model makes every published local catalog stale
 * at once.
 */
export function localProviderSettingsChanged(validated: AppSettings, previous: AppSettings): boolean {
  const next = validated.ai.local;
  const before = previous.ai.local;
  return next.endpoint !== before.endpoint || next.mode !== before.mode || next.model !== before.model;
}

/** Puts every store an optimistic edit touched back to a confirmed document. */
export function restoreStoresTo(rollback: AppSettings): void {
  const ui = useUiStore.getState();
  ui.setLoadedSettings(rollback);
  ui.setPalette(rollback.appearance.palette);
  ui.setCompanionTextSize(rollback.companion.textSize);
  void useReaderStore.getState().setReaderAppearance({
    reflowFontSize: rollback.reader.fontSize,
    reflowFontFamily: rollback.reader.fontFamily,
    reflowContentWidth: rollback.reader.contentWidth,
    reflowParagraphSpacing: rollback.reader.paragraphSpacing,
    reflowLineHeight: rollback.reader.lineSpacing,
    reflowHorizontalMarginRem: rollback.reader.pageMargin,
  });
}
