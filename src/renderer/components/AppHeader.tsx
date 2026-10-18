import { APP_NAME, APP_TAGLINE } from "@shared/constants/brand";
import type { PaletteId } from "@shared/constants/palettes";
import type { AppSettings } from "@shared/schemas/settings";
import { persistSettings } from "../app/api-client";
import { useUiStore } from "../stores/use-ui-store";
import { openFileFromDialog } from "../stores/use-open-file-store";
import { AppIcon } from "./AppIcon";
import { ThemeMenu } from "../features/theme/ThemeMenu";
import { withPalette } from "../features/theme/theme-choice";
import interleafLogo from "../assets/interleaf-logo.png";

function PanelLeftIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}

function PanelRightIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="15" y1="3" x2="15" y2="21" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function HelpCircleIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

/** Before settings load, the header menu reflects the palette already applied. */
function headerAppearance(settings: AppSettings | null, palette: PaletteId): AppSettings['appearance'] {
  return settings?.appearance ?? { palette };
}

export function AppHeader({ compact }: { readonly compact: boolean }) {
  const palette = useUiStore((state) => state.palette);
  const leftOpen = useUiStore((state) => state.leftOpen);
  const rightOpen = useUiStore((state) => state.rightOpen);
  const compactActivePanel = useUiStore((state) => state.compactActivePanel);
  const toggleLeft = useUiStore((state) => state.toggleLeft);
  const toggleRight = useUiStore((state) => state.toggleRight);
  const setPalette = useUiStore((state) => state.setPalette);
  const setShortcutsOpen = useUiStore((state) => state.setShortcutsOpen);
  const openSettings = useUiStore((state) => state.openSettings);
  const loadedSettings = useUiStore((state) => state.loadedSettings);
  const setLoadedSettings = useUiStore((state) => state.setLoadedSettings);

  const isLeftActive = compact ? compactActivePanel === 'left' : leftOpen;
  const isRightActive = compact ? compactActivePanel === 'right' : rightOpen;
  function handlePaletteSelect(id: PaletteId): void {
    if (loadedSettings === null) return;
    setPalette(id);
    const next = withPalette(loadedSettings, id);
    setLoadedSettings(next);
    persistSettings(next);
  }

  return (
    <header
      data-testid="app-header"
      className="flex h-14 shrink-0 items-center justify-between border-b border-border-subtle bg-bg-primary px-2 sm:px-3 min-w-0 max-w-full overflow-hidden"
    >
      <div className="flex items-center gap-1 sm:gap-2 min-w-0 shrink">
        <button
          type="button"
          data-testid="toggle-left-panel"
          onClick={toggleLeft}
          disabled={loadedSettings === null}
          aria-label="Toggle Library sidebar"
          aria-pressed={isLeftActive}
          aria-expanded={isLeftActive}
          aria-controls={compact ? 'compact-drawer-left' : 'library-sidebar'}
          title="Toggle Library sidebar"
          className="rounded-md p-1.5 sm:p-2 text-text-secondary hover:bg-bg-surface hover:text-text-primary shrink-0"
        >
          <PanelLeftIcon />
        </button>
        <button
          type="button"
          data-testid="toggle-right-panel"
          onClick={toggleRight}
          disabled={loadedSettings === null}
          aria-label="Toggle companion panel"
          aria-pressed={isRightActive}
          aria-expanded={isRightActive}
          aria-controls={compact ? 'compact-drawer-right' : 'companion-panel'}
          title="Toggle companion panel"
          className="rounded-md p-1.5 sm:p-2 text-text-secondary hover:bg-bg-surface hover:text-text-primary shrink-0"
        >
          <PanelRightIcon />
        </button>
        {/* The supplied logo raster has an opaque light background, so it sits
            on its own small light tile instead of directly on the header. That
            keeps it legible in every palette, including the dark ones. The
            compact mark is paired with the product name rather than the
            vertical wordmark, which is unreadable at header height. The tile is
            a rounded square, echoing the squircle application icon at the ~22%
            corner ratio that reads correctly at this size. */}
        <span
          data-testid="app-header-logo"
          className="ml-1 sm:ml-2 flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-white ring-1 ring-black/5"
        >
          <img src={interleafLogo} alt="" aria-hidden="true" className="h-full w-full object-contain" />
        </span>
        {/* The product name is a size larger than the tagline, so the header's
            `items-center` row would centre two line boxes of different heights
            and paint the name's glyphs lower than the tagline's. Their own row
            aligns on the shared text baseline instead, which is what makes the
            two words sit on one visual line. */}
        <span className="ml-1.5 flex items-baseline gap-1 sm:gap-2 min-w-0">
          <span
            data-testid="app-header-name"
            className="text-sm sm:text-base font-semibold tracking-tight shrink-0"
          >
            {APP_NAME}
          </span>
          <span
            data-testid="app-header-tagline"
            className="hidden min-[680px]:inline text-sm text-text-secondary truncate"
          >
            {APP_TAGLINE}
          </span>
        </span>
      </div>
      <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
        <ThemeMenu
          appearance={headerAppearance(loadedSettings, palette)}
          disabled={loadedSettings === null}
          onChoose={handlePaletteSelect}
          onAllThemes={() => { openSettings('theme'); }}
        />
        <button
          type="button"
          data-testid="open-file"
          onClick={() => { void openFileFromDialog(); }}
          aria-label="Open file"
          title="Open file (Ctrl+O)"
          className="rounded-md p-1.5 sm:p-2 text-text-secondary hover:bg-bg-surface hover:text-text-primary shrink-0"
        >
          <AppIcon name="open-file" size={18} />
        </button>
        <button
          type="button"
          data-testid="open-settings"
          onClick={() => { openSettings('ai'); }}
          aria-label="Settings"
          title="Settings (Ctrl+,)"
          className="rounded-md p-1.5 sm:p-2 text-text-secondary hover:bg-bg-surface hover:text-text-primary shrink-0"
        >
          <SettingsIcon />
        </button>
        <button
          type="button"
          data-testid="open-shortcuts"
          onClick={() => { setShortcutsOpen(true); }}
          aria-label="Show keyboard shortcuts"
          title="Keyboard shortcuts (?)"
          className="rounded-md p-1.5 sm:p-2 text-text-secondary hover:bg-bg-surface hover:text-text-primary shrink-0"
        >
          <HelpCircleIcon />
        </button>
      </div>
    </header>
  );
}
