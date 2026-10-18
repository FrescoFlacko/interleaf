import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliSearchPathFs } from '@main/app/cli-search-path';

/**
 * The automated-test isolation latch: an unpackaged app launched with
 * `INTERLEAF_ISOLATED_CLI_PATH=1` must search only the PATH it was given, while
 * every packaged or ordinary launch keeps the macOS well-known-directory
 * discovery unchanged.
 */
const INHERITED = '/fixture/bin:/usr/bin:/bin';
const everyDirectoryExists: CliSearchPathFs = { isDirectory: () => true, listDirectory: () => [] };
const darwinOptions = {
  platform: 'darwin' as const,
  inheritedPath: INHERITED,
  homeDirectory: '/Users/someone',
  fileSystem: everyDirectoryExists,
};

type SearchPathModules = {
  readonly applyTestCliSearchPathRestriction: typeof import('@main/app/cli-search-path-isolation').applyTestCliSearchPathRestriction;
  readonly buildCliSearchPath: typeof import('@main/app/cli-search-path').buildCliSearchPath;
};

/** Fresh module state, so each case starts with the latch open. */
async function freshModule(): Promise<SearchPathModules> {
  vi.resetModules();
  const isolation = await import('@main/app/cli-search-path-isolation');
  const searchPath = await import('@main/app/cli-search-path');
  return { applyTestCliSearchPathRestriction: isolation.applyTestCliSearchPathRestriction, buildCliSearchPath: searchPath.buildCliSearchPath };
}

describe('test-only CLI search-path restriction', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('appends host install directories when the flag is absent', async () => {
    const module = await freshModule();
    expect(module.applyTestCliSearchPathRestriction({ isPackaged: false, env: {} })).toBe(false);
    const searched = module.buildCliSearchPath(darwinOptions);
    expect(searched).toContain('/opt/homebrew/bin');
    expect(searched).toContain('/Users/someone/.local/bin');
  });

  it('is ignored by a packaged app even with the flag set', async () => {
    const module = await freshModule();
    expect(module.applyTestCliSearchPathRestriction({ isPackaged: true, env: { INTERLEAF_ISOLATED_CLI_PATH: '1' } })).toBe(false);
    expect(module.buildCliSearchPath(darwinOptions)).toContain('/opt/homebrew/bin');
  });

  it('requires the exact value 1', async () => {
    const module = await freshModule();
    expect(module.applyTestCliSearchPathRestriction({ isPackaged: false, env: { INTERLEAF_ISOLATED_CLI_PATH: 'true' } })).toBe(false);
    expect(module.buildCliSearchPath(darwinOptions)).toContain('/opt/homebrew/bin');
  });

  it('confines an unpackaged flagged run to the inherited PATH exactly', async () => {
    const module = await freshModule();
    expect(module.applyTestCliSearchPathRestriction({ isPackaged: false, env: { INTERLEAF_ISOLATED_CLI_PATH: '1' } })).toBe(true);
    expect(module.buildCliSearchPath(darwinOptions)).toBe(INHERITED);
    // One-way: a later unflagged call cannot lift the restriction.
    expect(module.applyTestCliSearchPathRestriction({ isPackaged: false, env: {} })).toBe(false);
    expect(module.buildCliSearchPath(darwinOptions)).toBe(INHERITED);
  });
});
