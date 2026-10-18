import { create } from "zustand";
import type { AgentExecutionMode } from "@shared/constants/agent-modes";
import {
  DEFAULT_SELECTABLE_EXECUTION_MODE,
  toSelectableDefaultExecutionMode,
  toSelectableExecutionMode,
  type SelectableAgentDefaultExecutionMode,
} from "@shared/constants/agent-mode-selection";
import { DEFAULT_PALETTE } from "@shared/constants/palettes";
import type { PaletteId } from "@shared/constants/palettes";
import {
  COMPANION_TEXT_SIZE_DEFAULT,
  normalizeCompanionTextSize,
  type AppSettings,
} from "@shared/schemas/settings";
import type { RightTab } from "../types/ui";

let focusModeReturnElement: HTMLElement | null = null;

type FocusWorkspaceSnapshot = {
  readonly leftOpen: boolean;
  readonly rightOpen: boolean;
  readonly leftWidth: number;
  readonly rightWidth: number;
  readonly rightTab: RightTab;
};

export function takeFocusModeReturnElement(): HTMLElement | null {
  const target = focusModeReturnElement;
  focusModeReturnElement = null;
  return target;
}

/**
 * Deep-link targets for the single Settings dialog. Every entry names one rail
 * section, so a caller asks for the section it means instead of opening Settings
 * and leaving the user to find it. `settings-rail.ts` maps each id to the
 * section (and, for `custom-profiles`, the selection) the dialog must show.
 * `ai:<provider row id>` opens AI Providers with that provider's row expanded.
 */
export type SettingsRailId =
  | 'general'
  | 'reader'
  | 'theme'
  | 'appearance'
  | 'library'
  | 'ai'
  | 'profiles'
  | 'custom-profiles'
  | 'working-directories'
  | 'sandboxing'
  | 'privacy'
  | 'advanced'
  | 'about'
  | `ai:${string}`;

type ComposerState = {
  executionMode: AgentExecutionMode;
  taskDraft: string;
}

export type UiState = {
  leftOpen: boolean;
  rightOpen: boolean;
  leftWidth: number;
  rightWidth: number;
  rightTab: RightTab;
  focusMode: boolean;
  compactActivePanel: 'left' | 'right' | null;
  shortcutsOpen: boolean;
  settingsOpen: boolean;
  /** Rail section the next/current Settings dialog opens on. */
  settingsTarget: SettingsRailId;
  palette: PaletteId;
  /** Readable-text scale shared by the AI Chat and Agent tabs. */
  companionTextSize: number;
  composer: ComposerState;
  /** Execution mode loaded from persisted settings; never a direct-workspace mode. */
  loadedAgentDefault: SelectableAgentDefaultExecutionMode;
  /**
   * Last settings document known to the renderer, used as persistence base;
   * `null` until settings hydrate (see `selectSettingsHydrated`).
   */
  loadedSettings: AppSettings | null;
  /** Ephemeral Focus Mode snapshot; never persisted. */
  focusSnapshot: FocusWorkspaceSnapshot | null;

  toggleLeft: () => void;
  toggleRight: () => void;
  setCompactActivePanel: (panel: 'left' | 'right' | null) => void;
  setRightTab: (tab: RightTab) => void;
  setLeftWidth: (width: number) => void;
  setRightWidth: (width: number) => void;
  showRightTab: (tab: RightTab) => void;
  toggleFocusMode: (canEnter?: boolean) => void;
  setPalette: (palette: PaletteId) => void;
  /**
   * Applies a companion text scale to the live UI. Presentation only, like
   * `setPalette`: the control that changed it owns the settings write, so a
   * Settings-modal preview does not race the modal's own document write.
   */
  setCompanionTextSize: (size: number) => void;
  setShortcutsOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  /** Opens Settings on a named rail section (an explicit deep link). */
  openSettings: (target: SettingsRailId) => void;
  hydrate: (settings: AppSettings) => void;
  setLoadedSettings: (settings: AppSettings) => void;
  setComposerExecutionMode: (mode: AgentExecutionMode) => void;
  setTaskDraft: (draft: string) => void;
}


/**
 * Moves focus to a panel's owning header toggle BEFORE closing state flips.
 * Called synchronously inside store actions so keyboard focus never lands on
 * `<body>` between the hide mutation and any later effect-based restore
 * (Defect 22 focus contract). No-ops safely outside jsdom/browser contexts.
 */
function focusOwningPanelToggle(panel: 'left' | 'right'): void {
  if (typeof document === 'undefined') return;
  const active = document.activeElement;
  const root =
    document.querySelector<HTMLElement>(panel === 'left' ? '[data-testid="resizable-panel-left"]' : '[data-testid="resizable-panel-right"]')
    ?? document.querySelector<HTMLElement>(panel === 'left' ? '[data-testid="compact-drawer-left"]' : '[data-testid="compact-drawer-right"]');
  const ownsFocus = root !== null && active !== null && root.contains(active);
  const bodyIsFree = active === null || active === document.body || active === document.documentElement;
  if (!ownsFocus && !bodyIsFree) return;
  document.querySelector<HTMLElement>(`[data-testid="toggle-${panel}-panel"]`)?.focus();
}

/** Whether persisted settings have reached the renderer; layout writes wait for it. */
export function selectSettingsHydrated(state: Pick<UiState, 'loadedSettings'>): boolean {
  return state.loadedSettings !== null;
}

export const useUiStore = create<UiState>((set) => ({
  leftOpen: true,
  // Closed until settings first hydrate, so a profile that opted out of the
  // startup drawer never sees it flash open while settings load. The first
  // `hydrate` applies `layout.openRightPanelOnStartup` (open by default).
  rightOpen: false,
  leftWidth: 256,
  rightWidth: 320,
  rightTab: "chat",
  focusMode: false,
  compactActivePanel: null,
  shortcutsOpen: false,
  settingsOpen: false,
  settingsTarget: 'ai',
  palette: DEFAULT_PALETTE,
  companionTextSize: COMPANION_TEXT_SIZE_DEFAULT,
  composer: {
    executionMode: DEFAULT_SELECTABLE_EXECUTION_MODE,
    taskDraft: "",
  },
  loadedAgentDefault: DEFAULT_SELECTABLE_EXECUTION_MODE,
  loadedSettings: null,
  focusSnapshot: null,

  toggleLeft: () => {
    if (typeof window !== 'undefined' && window.innerWidth < 920) {
      set((state) => {
        if (state.compactActivePanel === 'left') focusOwningPanelToggle('left');
        return { compactActivePanel: state.compactActivePanel === 'left' ? null : 'left' };
      });
    } else {
      set((state) => {
        if (state.leftOpen) focusOwningPanelToggle('left');
        return { leftOpen: !state.leftOpen };
      });
    }
  },
  toggleRight: () => {
    if (typeof window !== 'undefined' && window.innerWidth < 920) {
      set((state) => {
        if (state.compactActivePanel === 'right') focusOwningPanelToggle('right');
        return { compactActivePanel: state.compactActivePanel === 'right' ? null : 'right' };
      });
    } else {
      set((state) => {
        if (state.rightOpen) focusOwningPanelToggle('right');
        return { rightOpen: !state.rightOpen };
      });
    }
  },
  setCompactActivePanel: (panel) => {
    if (panel === null) {
      set((state) => {
        if (state.compactActivePanel !== null) focusOwningPanelToggle(state.compactActivePanel);
        return { compactActivePanel: null };
      });
      return;
    }
    set({ compactActivePanel: panel });
  },
  setRightTab: (tab) => { set({ rightTab: tab }); },
  setLeftWidth: (width) => { set({ leftWidth: Math.round(Math.min(440, Math.max(220, Number.isFinite(width) ? width : 256))) }); },
  setRightWidth: (width) => { set({ rightWidth: Math.round(Math.min(560, Math.max(280, Number.isFinite(width) ? width : 320))) }); },
  showRightTab: (tab) => {
    if (typeof window !== 'undefined' && window.innerWidth < 920) {
      set({ compactActivePanel: 'right', rightTab: tab });
    } else {
      set({ rightOpen: true, rightTab: tab });
    }
  },
  toggleFocusMode: (canEnter = true) => {
    set((state) => {
      if (!state.focusMode) {
        if (!canEnter) return state;
        if (typeof document !== "undefined") {
          const active = document.activeElement;
          focusModeReturnElement =
            active instanceof HTMLElement && active !== document.body && active !== document.documentElement
              ? active
              : null;
        }
        return {
          focusMode: true,
          focusSnapshot: {
            leftOpen: state.leftOpen,
            rightOpen: state.rightOpen,
            leftWidth: state.leftWidth,
            rightWidth: state.rightWidth,
            rightTab: state.rightTab,
          },
          leftOpen: false,
          rightOpen: false,
          compactActivePanel: null,
        };
      }
      const snapshot = state.focusSnapshot;
      return {
        focusMode: false,
        focusSnapshot: null,
        compactActivePanel: null,
        ...(snapshot ?? {}),
      };
    });
  },
  setPalette: (palette) => { set({ palette }); },
  setCompanionTextSize: (size) => { set({ companionTextSize: normalizeCompanionTextSize(size) }); },
  setShortcutsOpen: (open) => { set({ shortcutsOpen: open }); },
  setSettingsOpen: (open) => { set({ settingsOpen: open }); },
  openSettings: (target) => { set({ settingsOpen: true, settingsTarget: target }); },
  hydrate: (settings) =>
    { set((state) => {
      // Only the first hydration is a launch. A later one (for example a
      // stale read finishing after the reader toggled the drawer) keeps the
      // live state instead of undoing that toggle.
      const rightOpen = selectSettingsHydrated(state) ? state.rightOpen : settings.layout.openRightPanelOnStartup;
      return {
        palette: settings.appearance.palette,
        companionTextSize: normalizeCompanionTextSize(settings.companion.textSize),
        leftWidth: settings.layout.leftWidth,
        rightWidth: settings.layout.rightWidth,
        leftOpen: settings.layout.leftOpen,
        // A persisted `container-sandbox` default stays in storage and stays
        // fail-closed in main; the UI resolves it to the recommended default so
        // the composer never sits on a mode it cannot offer.
        composer: {
          ...state.composer,
          executionMode: toSelectableExecutionMode(settings.agent.defaultExecutionMode),
        },
        loadedAgentDefault: toSelectableDefaultExecutionMode(settings.agent.defaultExecutionMode),
        rightOpen,
        loadedSettings: { ...settings, layout: { ...settings.layout, rightOpen } },
      };
    }); },
  setLoadedSettings: (settings) => { set({ loadedSettings: settings }); },
  setComposerExecutionMode: (mode) =>
    { set((state) => ({
      composer: { ...state.composer, executionMode: mode },
    })); },
  setTaskDraft: (draft) =>
    { set((state) => ({
      composer: { ...state.composer, taskDraft: draft },
    })); },
}));
