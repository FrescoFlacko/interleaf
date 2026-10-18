import type { PortableMember } from '../models/portable';
import { PALETTE_IDS, PALETTES, type PaletteId, type PaletteInfo } from './palettes';

const PALETTE_ID_SET: ReadonlySet<string> = new Set(PALETTE_IDS);
const PALETTE_INFO = new Map(PALETTES.map((info) => [info.id, info]));

/** Narrows an untrusted stored value (for example a setting) to a palette id. */
export function isPaletteId(value: PortableMember): value is PaletteId {
  return typeof value === 'string' && PALETTE_ID_SET.has(value);
}

export function paletteInfo(id: PaletteId): PaletteInfo {
  return PALETTE_INFO.get(id) ?? { id, label: id, mood: '', appearance: 'light' };
}
