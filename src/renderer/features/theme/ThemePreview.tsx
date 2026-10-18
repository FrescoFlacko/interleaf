import type { ReactElement } from 'react';
import type { PaletteId } from '@shared/constants/palettes';
import { PALETTE_TOKENS } from '@shared/constants/palette-tokens';

/**
 * A miniature of the app in one theme: sidebar, reader page with body and
 * secondary text lines, a selection, an accent button and the companion
 * column. Colours come straight from the token table as SVG presentation
 * attributes (not inline styles), so every preview shows its own theme
 * whatever theme is applied, and the renderer CSP is unaffected.
 */
export function ThemePreview({ palette, className }: { readonly palette: PaletteId; readonly className?: string }): ReactElement {
  const t = PALETTE_TOKENS[palette];
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 120 72" className={className} preserveAspectRatio="xMidYMid slice">
      <rect width="120" height="72" fill={t['bg-primary']} />
      <rect width="26" height="72" fill={t['bg-surface']} />
      <rect x="5" y="8" width="16" height="3" rx="1.5" fill={t['text-secondary']} />
      <rect x="5" y="15" width="12" height="3" rx="1.5" fill={t['text-secondary']} />
      <rect x="4" y="22" width="18" height="5" rx="1.5" fill={t['accent-muted']} />
      <rect x="32" y="6" width="56" height="60" rx="3" fill={t['bg-reader']} stroke={t['border-subtle']} strokeWidth="0.75" />
      <rect x="38" y="13" width="34" height="4" rx="1.5" fill={t['text-primary']} />
      <rect x="38" y="23" width="44" height="2.5" rx="1" fill={t['text-primary']} />
      <rect x="37" y="28.5" width="30" height="5" rx="1" fill={t.selection} />
      <rect x="38" y="29.75" width="42" height="2.5" rx="1" fill={t['text-primary']} />
      <rect x="38" y="36" width="40" height="2.5" rx="1" fill={t['text-secondary']} />
      <rect x="38" y="41" width="36" height="2.5" rx="1" fill={t['text-secondary']} />
      <rect x="38" y="50" width="20" height="8" rx="2" fill={t.accent} />
      <rect x="42" y="53" width="12" height="2" rx="1" fill={t['on-accent']} />
      <rect x="94" y="6" width="22" height="60" rx="3" fill={t['bg-surface-elevated']} stroke={t['border-subtle']} strokeWidth="0.75" />
      <rect x="98" y="12" width="14" height="2.5" rx="1" fill={t['text-secondary']} />
      <rect x="98" y="18" width="12" height="2.5" rx="1" fill={t['text-secondary']} />
      <circle cx="105" cy="58" r="3.5" fill={t['focus-ring']} />
    </svg>
  );
}
