import type { PaletteId } from '@shared/constants/palettes';
import { MAX_RECENT_PALETTES, type AppSettings } from '@shared/schemas/settings';

/**
 * Recent themes before the reader has changed theme in this build: the six
 * original palettes, so the header menu starts with the themes people knew.
 */
export const DEFAULT_RECENT_PALETTES: readonly PaletteId[] = ['paper', 'sepia', 'moss', 'ocean', 'graphite', 'midnight'];

export function recentPalettes(appearance: AppSettings['appearance']): readonly PaletteId[] {
  return appearance.recentPalettes ?? DEFAULT_RECENT_PALETTES;
}

/** Recent themes other than `current`, newest first, without duplicates. */
function othersThan(current: PaletteId, ids: readonly PaletteId[]): PaletteId[] {
  return ids.filter((id, index) => id !== current && ids.indexOf(id) === index).slice(0, MAX_RECENT_PALETTES);
}

/**
 * The settings document with `palette` as the theme. The theme it replaces
 * moves to the front of the recent list, which keeps at most six others.
 */
export function withPalette(settings: AppSettings, palette: PaletteId): AppSettings {
  const previous = settings.appearance.palette;
  return {
    ...settings,
    appearance: {
      palette,
      recentPalettes: othersThan(palette, [previous, ...recentPalettes(settings.appearance)]),
    },
  };
}

/** The header menu's themes: the current one, then up to six recent ones. */
export function headerThemes(appearance: AppSettings['appearance']): readonly PaletteId[] {
  return [appearance.palette, ...othersThan(appearance.palette, recentPalettes(appearance))];
}
