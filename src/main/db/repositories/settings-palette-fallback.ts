import { DEFAULT_PALETTE } from '@shared/constants/palettes';
import { isPaletteId } from '@shared/constants/palette-lookup';
import type { PortableMember, PortableRecord, PortableValue } from '@shared/models/portable';

function asRecord(value: PortableMember): PortableRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as PortableRecord) : null;
}

/** The stored appearance with unknown theme ids replaced or dropped, or `null` when nothing changes. */
function knownAppearance(appearance: PortableRecord): PortableRecord | null {
  const palette = appearance.palette;
  const recent = appearance.recentPalettes;
  const unknownPalette = palette !== undefined && !isPaletteId(palette);
  const recentList: readonly PortableMember[] = Array.isArray(recent) ? recent : [];
  const knownRecent = recentList.filter((id) => isPaletteId(id));
  if (!unknownPalette && knownRecent.length === recentList.length) return null;
  return {
    ...appearance,
    ...(unknownPalette ? { palette: DEFAULT_PALETTE } : {}),
    ...(Array.isArray(recent) ? { recentPalettes: knownRecent } : {}),
  };
}

/**
 * Settings written by a newer build can name a palette this build does not
 * know. Only that field falls back (to the default palette, to "Match theme"
 * for the reader background, or out of the recent-themes list); every other
 * stored setting is kept, instead of the whole document failing validation
 * and resetting to defaults. Writes are still validated strictly by the schema.
 */
export function replaceUnknownPalettes(value: PortableValue): PortableValue {
  const root = asRecord(value);
  if (root === null) return value;
  const appearance = asRecord(root.appearance);
  const reader = asRecord(root.reader);
  const background = reader?.background;
  const fixedAppearance = appearance === null ? null : knownAppearance(appearance);
  const unknownBackground = reader !== null && background !== undefined && background !== 'palette' && !isPaletteId(background);
  if (fixedAppearance === null && !unknownBackground) return value;
  return {
    ...root,
    ...(fixedAppearance === null ? {} : { appearance: fixedAppearance }),
    ...(unknownBackground ? { reader: { ...reader, background: 'palette' } } : {}),
  };
}
