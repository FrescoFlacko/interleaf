import { normalizeCompanionTextSize } from '@shared/schemas/settings';

/** The preference as the reader reads it, rather than as a multiplier. */
export function companionTextSizeLabel(scale: number): string {
  return `${String(Math.round(normalizeCompanionTextSize(scale) * 100))}%`;
}
