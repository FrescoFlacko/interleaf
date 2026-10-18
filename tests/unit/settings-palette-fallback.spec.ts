import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InterleafDatabase } from '@main/db/database';
import { runMigrations } from '@main/db/migrations';
import { SettingsRepository } from '@main/db/repositories/settings-repository';
import { replaceUnknownPalettes } from '@main/db/repositories/settings-palette-fallback';
import { appSettingsSchema, DEFAULT_APP_SETTINGS } from '@shared/schemas/settings';
import { DEFAULT_PALETTE, PALETTE_IDS } from '@shared/constants/palettes';
import type { Logger } from '@main/logging/logger';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe('palette settings schema', () => {
  it.each(PALETTE_IDS)('accepts %s as the app palette and as the reader background', (id) => {
    const parsed = appSettingsSchema.safeParse({
      ...DEFAULT_APP_SETTINGS,
      appearance: { palette: id },
      reader: { ...DEFAULT_APP_SETTINGS.reader, background: id },
    });
    expect(parsed.success).toBe(true);
  });

  it('still rejects an unknown palette on write', () => {
    expect(appSettingsSchema.safeParse({ ...DEFAULT_APP_SETTINGS, appearance: { palette: 'neon' } }).success).toBe(false);
    expect(appSettingsSchema.safeParse({
      ...DEFAULT_APP_SETTINGS,
      reader: { ...DEFAULT_APP_SETTINGS.reader, background: 'neon' },
    }).success).toBe(false);
  });
});

describe('replaceUnknownPalettes', () => {
  it('leaves known values untouched', () => {
    const stored = { appearance: { palette: 'graphite' }, reader: { background: 'sepia', fontSize: 1.2 } };
    expect(replaceUnknownPalettes(stored)).toBe(stored);
  });

  it('replaces only the unknown fields', () => {
    const stored = { appearance: { palette: 'neon' }, reader: { background: 'glow', fontSize: 1.2 }, other: 1 };
    expect(replaceUnknownPalettes(stored)).toEqual({
      appearance: { palette: DEFAULT_PALETTE },
      reader: { background: 'palette', fontSize: 1.2 },
      other: 1,
    });
  });

  it('drops unknown ids from the recent themes and keeps the known ones in order', () => {
    const stored = { appearance: { palette: 'nocturne', recentPalettes: ['sepia', 'neon', 'moss'] } };
    expect(replaceUnknownPalettes(stored)).toEqual({ appearance: { palette: 'nocturne', recentPalettes: ['sepia', 'moss'] } });
  });

  it('accepts at most six recent themes on write', () => {
    const recentPalettes = PALETTE_IDS.slice(0, 7);
    expect(appSettingsSchema.safeParse({ ...DEFAULT_APP_SETTINGS, appearance: { palette: 'paper', recentPalettes } }).success).toBe(false);
    expect(appSettingsSchema.safeParse({
      ...DEFAULT_APP_SETTINGS,
      appearance: { palette: 'paper', recentPalettes: recentPalettes.slice(0, 6) },
    }).success).toBe(true);
  });

  it('ignores non-object documents', () => {
    expect(replaceUnknownPalettes(null)).toBeNull();
    expect(replaceUnknownPalettes([1, 2])).toEqual([1, 2]);
  });
});

describe('SettingsRepository palette fallback', () => {
  let db: InterleafDatabase;
  let repo: SettingsRepository;

  beforeEach(() => {
    db = InterleafDatabase.open(':memory:');
    runMigrations(db);
    repo = new SettingsRepository(db, logger);
  });

  afterEach(() => {
    db.close();
  });

  function store(value: object): void {
    db.raw.prepare('UPDATE settings SET value_json = ? WHERE key = ?').run(JSON.stringify(value), 'app');
  }

  it('keeps every legacy palette id after an upgrade', () => {
    const initial = repo.get();
    for (const legacy of ['paper', 'sepia', 'moss', 'ocean', 'graphite', 'midnight'] as const) {
      store({ ...initial, appearance: { palette: legacy }, reader: { ...initial.reader, background: legacy } });
      const loaded = repo.get();
      expect(loaded.appearance.palette).toBe(legacy);
      expect(loaded.reader.background).toBe(legacy);
    }
  });

  it('falls back from an unknown palette without discarding other settings', () => {
    const initial = repo.get();
    store({
      ...initial,
      appearance: { palette: 'from-a-newer-build' },
      reader: { ...initial.reader, background: 'also-unknown', fontSize: 1.4, fontFamily: 'serif' },
    });
    const loaded = repo.get();
    expect(loaded.appearance.palette).toBe(DEFAULT_PALETTE);
    expect(loaded.reader.background).toBe('palette');
    expect(loaded.reader.fontSize).toBe(1.4);
    expect(loaded.reader.fontFamily).toBe('serif');
  });

  it('persists a new palette and reads it back', () => {
    repo.update({ ...repo.get(), appearance: { palette: 'nocturne' } });
    expect(repo.get().appearance.palette).toBe('nocturne');
  });
});
