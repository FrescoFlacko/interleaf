import { useEffect, useRef } from 'react';
import type { PaletteId } from '@shared/constants/palettes';
import { applyPalette, applyPaletteWithTransition } from './apply-palette';

/**
 * Keeps the document root on the active palette. The first application and
 * the one that lands with settings hydration are instant; only a palette the
 * reader changes afterwards cross-fades.
 */
export function useAppliedPalette(palette: PaletteId, settingsHydrated: boolean): void {
  const animate = useRef(false);
  useEffect(() => {
    if (animate.current) applyPaletteWithTransition(palette);
    else applyPalette(palette);
    animate.current = settingsHydrated;
  }, [palette, settingsHydrated]);
}
