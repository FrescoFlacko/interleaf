import type { ReactElement } from 'react';
import type { PaletteId } from '@shared/constants/palettes';
import { PALETTE_TOKENS } from '@shared/constants/palette-tokens';

/**
 * A theme's page colour with its accent as a dot: enough to tell themes apart
 * at 16–20px. Shared by the header theme menu and the reader-background list.
 */
export function ThemeSwatch({ palette, size }: { readonly palette: PaletteId; readonly size: number }): ReactElement {
  const tokens = PALETTE_TOKENS[palette];
  return (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 20 20" className="shrink-0">
      <circle cx="10" cy="10" r="9" fill={tokens['bg-reader']} stroke={tokens['border-strong']} strokeWidth="1" />
      <circle cx="10" cy="10" r="4" fill={tokens.accent} />
    </svg>
  );
}
