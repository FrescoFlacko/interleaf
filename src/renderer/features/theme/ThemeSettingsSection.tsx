import { useEffect, useRef, type KeyboardEvent, type ReactElement } from 'react';
import { PALETTES, type PaletteAppearance, type PaletteId, type PaletteInfo } from '@shared/constants/palettes';
import type { AppSettings } from '@shared/schemas/settings';
import { Select, type SelectOption } from '../../components/ui/select';
import { AppIcon } from '../../components/AppIcon';
import { cn } from '../../components/ui/cn';
import { useUiStore } from '../../stores/use-ui-store';
import { SettingsSectionHeader } from '../chat/SettingsSectionHeader';
import { ThemePreview } from './ThemePreview';
import { ThemeSwatch } from './ThemeSwatch';
import { withPalette } from './theme-choice';

type ReaderBackground = AppSettings['reader']['background'];

const READER_BACKGROUND_OPTIONS: readonly SelectOption<ReaderBackground>[] = [
  { value: 'palette', label: 'Match app theme' },
  ...PALETTES.map((palette) => ({
    value: palette.id,
    label: palette.label,
    description: palette.mood,
    leading: <ThemeSwatch palette={palette.id} size={16} />,
  })),
];

const GROUPS: readonly { readonly appearance: PaletteAppearance; readonly title: string }[] = [
  { appearance: 'light', title: 'Light' },
  { appearance: 'dark', title: 'Dark' },
];

/** Under its Light or Dark heading a card drops the repeated word ("High Contrast"). */
function shortLabel(palette: PaletteInfo): string {
  const suffix = palette.appearance === 'dark' ? ' Dark' : ' Light';
  return palette.label.endsWith(suffix) ? palette.label.slice(0, -suffix.length) : palette.label;
}

/** Arrow keys move through the radio group in reading order, wrapping at the ends. */
const KEY_STEPS: Readonly<Record<string, number>> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

function nextPaletteIndex(key: string, index: number): number | null {
  if (key === 'Home') return 0;
  if (key === 'End') return PALETTES.length - 1;
  const step = KEY_STEPS[key];
  return step === undefined ? null : (index + step + PALETTES.length) % PALETTES.length;
}

type ThemeSettingsSectionProps = {
  readonly settings: AppSettings;
  readonly onChange: (next: AppSettings) => void;
};

/**
 * Settings → Theme: every theme as a live preview card in one radio group
 * (arrow keys move and choose, as radios do, across both the Light and Dark
 * headings), plus the reader page background, which can follow the app theme
 * or use any theme's page colour.
 */
export function ThemeSettingsSection({ settings, onChange }: ThemeSettingsSectionProps): ReactElement {
  const groupRef = useRef<HTMLDivElement>(null);
  const current = settings.appearance.palette;

  const choose = (palette: PaletteId): void => {
    if (palette === current) return;
    onChange(withPalette(settings, palette));
    useUiStore.getState().setPalette(palette);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const next = nextPaletteIndex(event.key, index);
    const palette = next === null ? undefined : PALETTES[next];
    if (palette === undefined) return;
    event.preventDefault();
    choose(palette.id);
    groupRef.current?.querySelector<HTMLElement>(`[data-palette="${palette.id}"]`)?.focus();
  };

  // Opening on a dark theme should show it, not the first rows of light ones.
  // A card already in view is left where it is, so a light theme still opens
  // on the section heading; one that had to be revealed is centred rather than
  // left on the bottom edge, and the sticky group label above it says which
  // group it is in. Only on mount: later choices are a click or key on a card
  // already in view.
  useEffect(() => {
    const checked = groupRef.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    if (!checked || typeof checked.scrollIntoView !== 'function') return;
    const before = checked.getBoundingClientRect().top;
    checked.scrollIntoView({ block: 'nearest' });
    if (checked.getBoundingClientRect().top !== before) checked.scrollIntoView({ block: 'center' });
  }, []);

  return (
    <section aria-labelledby="settings-theme-heading">
      <SettingsSectionHeader
        id="settings-theme-heading"
        title="Theme"
        description="Each theme sets the colours of the app and the reader page together. A document’s own images, and diagrams pinned to their source colours, keep theirs. Changes apply immediately and are saved on this device."
      />
      <div
        ref={groupRef}
        role="radiogroup"
        aria-labelledby="settings-theme-heading"
        data-testid="theme-radiogroup"
        className="flex flex-col gap-5"
      >
        {GROUPS.map((group) => {
          const members = PALETTES.filter((palette) => palette.appearance === group.appearance);
          return (
            // Each group is named by its visible label, so the Light/Dark
            // split is announced as well as seen.
            <div
              key={group.appearance}
              role="group"
              aria-labelledby={`theme-group-${group.appearance}-label`}
              data-testid={`theme-group-${group.appearance}`}
              className="flex flex-col gap-2"
            >
              {/* Sticky within the settings scroll area, so a card scrolled
                  far into a group still sits under that group's name. */}
              <div
                data-testid={`theme-group-${group.appearance}-heading`}
                className="sticky top-0 z-10 flex items-baseline gap-2 bg-bg-primary py-1 text-xs font-medium text-text-secondary"
              >
                <span id={`theme-group-${group.appearance}-label`}>{group.title}</span>
                <span className="font-normal">{members.length}</span>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {members.map((palette) => {
                  const index = PALETTES.indexOf(palette);
                  const checked = palette.id === current;
                  return (
                    <button
                      key={palette.id}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      aria-label={palette.label}
                      aria-describedby={`theme-mood-${palette.id}`}
                      tabIndex={checked ? 0 : -1}
                      data-palette={palette.id}
                      data-testid={`theme-option-${palette.id}`}
                      title={palette.label}
                      onClick={() => { choose(palette.id); }}
                      onKeyDown={(event) => { handleKeyDown(event, index); }}
                      className={cn(
                        'relative flex min-w-0 flex-col overflow-hidden rounded-lg border bg-bg-surface text-left transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2',
                        'focus-visible:ring-offset-bg-primary',
                        checked ? 'border-accent ring-1 ring-accent' : 'border-border-subtle hover:border-border-strong'
                      )}
                    >
                      <ThemePreview palette={palette.id} className="aspect-[5/3] w-full" />
                      {checked && (
                        <span
                          aria-hidden="true"
                          data-testid="theme-option-check"
                          className="absolute right-2 top-2 flex size-5 items-center justify-center rounded-full bg-accent text-on-accent shadow-sm"
                        >
                          <AppIcon name="check" size={12} />
                        </span>
                      )}
                      <span className="truncate px-3 pt-2 text-sm font-medium text-text-primary">{shortLabel(palette)}</span>
                      <span id={`theme-mood-${palette.id}`} className="px-3 pb-3 pt-0.5 text-xs text-text-secondary">{palette.mood}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-6 max-w-sm">
        <label htmlFor="settings-reader-background" className="text-xs font-medium text-text-secondary">Reader page background</label>
        <Select
          id="settings-reader-background"
          data-testid="settings-reader-background"
          value={settings.reader.background}
          options={READER_BACKGROUND_OPTIONS}
          onValueChange={(background) => { onChange({ ...settings, reader: { ...settings.reader, background } }); }}
          wrapperClassName="mt-2"
        />
        <p className="mt-2 text-xs text-text-secondary">The page behind a document can keep its own theme’s colours while the rest of the app changes.</p>
      </div>
    </section>
  );
}
