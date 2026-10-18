import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS, MAX_RECENT_PALETTES } from '@shared/schemas/settings';
import { DEFAULT_RECENT_PALETTES, headerThemes, recentPalettes, withPalette } from '../../src/renderer/features/theme/theme-choice';

describe('theme choice', () => {
  it('starts the recent list with the six original themes', () => {
    expect(recentPalettes({ palette: 'paper' })).toEqual(DEFAULT_RECENT_PALETTES);
    expect(headerThemes({ palette: 'paper' })).toEqual(['paper', 'sepia', 'moss', 'ocean', 'graphite', 'midnight']);
  });

  it('puts the current theme first in the header menu without repeating it', () => {
    expect(headerThemes({ palette: 'moss' })).toEqual(['moss', 'paper', 'sepia', 'ocean', 'graphite', 'midnight']);
    expect(headerThemes({ palette: 'nocturne', recentPalettes: ['sepia'] })).toEqual(['nocturne', 'sepia']);
  });

  it('moves the replaced theme to the front of the recent list and keeps other settings', () => {
    const settings = { ...DEFAULT_APP_SETTINGS, appearance: { palette: 'sepia' as const, recentPalettes: ['moss' as const, 'paper' as const] } };
    const next = withPalette(settings, 'nocturne');
    expect(next.appearance).toEqual({ palette: 'nocturne', recentPalettes: ['sepia', 'moss', 'paper'] });
    expect(next.reader).toBe(settings.reader);
  });

  it('never lists the chosen theme as recent and caps the list', () => {
    const settings = { ...DEFAULT_APP_SETTINGS, appearance: { palette: 'paper' as const } };
    const next = withPalette(withPalette(settings, 'nocturne'), 'sepia');
    expect(next.appearance.recentPalettes).not.toContain('sepia');
    expect(next.appearance.recentPalettes?.[0]).toBe('nocturne');
    expect(next.appearance.recentPalettes).toHaveLength(MAX_RECENT_PALETTES);
  });
});
