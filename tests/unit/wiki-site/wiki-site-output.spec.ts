import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTPUT_MARKER, buildSite, prepareOutputDirectory } from '../../../wiki.build';
import { parsePortableJson } from '@shared/models/portable';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * All fixtures live in a canonical temporary directory of this test's own
 * making: nothing here points at a real user directory, and every rejection
 * case is checked by proving a sentinel file was left alone.
 */
let base = '';

beforeEach(async () => {
  // `realpath` because macOS exposes the temporary directory through symlinks.
  base = await realpath(await mkdtemp(join(tmpdir(), 'interleaf-wiki-out-')));
});

afterEach(async () => {
  if (base !== '') await rm(base, { recursive: true, force: true });
});

async function sentinel(directory: string, name = 'keep-me.txt'): Promise<string> {
  await mkdir(directory, { recursive: true });
  const file = join(directory, name);
  await writeFile(file, 'user data', 'utf8');
  return file;
}

async function survives(file: string): Promise<string> {
  return readFile(file, 'utf8');
}

describe('output directory safety', () => {
  it('creates a missing directory and marks it as its own', async () => {
    const outDir = join(base, 'site');
    const prepared = await prepareOutputDirectory(outDir, projectRoot);
    expect(prepared).toEqual({ outDir, reused: false });
    expect(await readdir(outDir)).toEqual([]);
  });

  it('adopts an existing empty directory', async () => {
    const outDir = join(base, 'empty');
    await mkdir(outDir);
    expect((await prepareOutputDirectory(outDir, projectRoot)).reused).toBe(false);
  });

  it('refuses a non-empty directory it does not own, and deletes nothing', async () => {
    const outDir = join(base, 'user-files');
    const keep = await sentinel(outDir);
    const nested = await sentinel(join(outDir, 'nested'), 'notes.md');
    await expect(prepareOutputDirectory(outDir, projectRoot)).rejects.toThrow(/not empty/u);
    expect(await survives(keep)).toBe('user data');
    expect(await survives(nested)).toBe('user data');
  });

  it('refuses a directory whose marker is not a site this generator wrote', async () => {
    const outDir = join(base, 'foreign');
    const keep = await sentinel(outDir);
    for (const content of ['not json at all', '{"generator":"something-else","version":1}', '[]']) {
      await writeFile(join(outDir, OUTPUT_MARKER), content, 'utf8');
      await expect(prepareOutputDirectory(outDir, projectRoot)).rejects.toThrow(/Refusing to reuse/u);
      expect(await survives(keep)).toBe('user data');
    }
  });

  it('refuses a marker that lists paths outside the output directory', async () => {
    const outDir = join(base, 'escaping');
    const keep = await sentinel(base, 'outside.txt');
    await mkdir(outDir);
    await writeFile(
      join(outDir, OUTPUT_MARKER),
      JSON.stringify({
        generator: 'interleaf-wiki-site',
        version: 1,
        generatedAt: '2026-09-15T00:00:00.000Z',
        files: ['../outside.txt'],
      }),
      'utf8',
    );
    await expect(prepareOutputDirectory(outDir, projectRoot)).rejects.toThrow(/Refusing to reuse/u);
    expect(await survives(keep)).toBe('user data');
  });

  it('refuses a target reached through a symbolic link', async () => {
    const real = join(base, 'private');
    const keep = await sentinel(real);
    await symlink(real, join(base, 'link'));
    await expect(prepareOutputDirectory(join(base, 'link'), projectRoot)).rejects.toThrow(/symbolic link/u);
    await expect(prepareOutputDirectory(join(base, 'link', 'site'), projectRoot)).rejects.toThrow(/symbolic link/u);
    expect(await survives(keep)).toBe('user data');
    expect(await readdir(real)).toEqual(['keep-me.txt']);
  });

  it('refuses the project root, its parents, and protected project directories', async () => {
    for (const target of [projectRoot, join(projectRoot, '..'), join(projectRoot, 'src'), join(projectRoot, 'docs'), join(projectRoot, 'docs', 'wiki'), join(projectRoot, '.git')]) {
      await expect(prepareOutputDirectory(target, projectRoot)).rejects.toThrow(/Refusing to build into/u);
    }
    // The wiki source is untouched by the rejected calls above.
    expect(await readFile(join(projectRoot, 'docs', 'wiki', 'README.md'), 'utf8')).toContain('Interleaf Wiki');
  });

  it('refuses a filesystem root', async () => {
    await expect(prepareOutputDirectory('/', projectRoot)).rejects.toThrow(/filesystem root/u);
  });

  /** A marker for `outDir` listing exactly `files`, as a previous build leaves. */
  async function writeMarker(outDir: string, files: readonly string[]): Promise<void> {
    await mkdir(outDir, { recursive: true });
    await writeFile(
      join(outDir, OUTPUT_MARKER),
      JSON.stringify({
        generator: 'interleaf-wiki-site',
        version: 1,
        generatedAt: '2026-09-15T00:00:00.000Z',
        files,
      }),
      'utf8',
    );
  }

  it('refuses a generated subdirectory that was replaced by a symbolic link', async () => {
    const outDir = join(base, 'site');
    const elsewhere = join(base, 'elsewhere');
    // The same file names the site generates, but in somebody else's directory.
    const victim = await sentinel(elsewhere, 'wiki.css');
    await writeMarker(outDir, ['index.html', 'assets/wiki.css', 'assets/search-index.js']);
    const page = join(outDir, 'index.html');
    await writeFile(page, 'generated', 'utf8');
    await symlink(elsewhere, join(outDir, 'assets'));

    await expect(prepareOutputDirectory(outDir, projectRoot)).rejects.toThrow(/not a plain directory/u);
    expect(await survives(victim)).toBe('user data');
    expect(await readdir(elsewhere)).toEqual(['wiki.css']);
    // The plan is validated as a whole, so an earlier, perfectly valid entry
    // was not deleted on the way to the bad one.
    expect(await survives(page)).toBe('generated');
  });

  it('preserves earlier marker files when a later entry is not a regular file', async () => {
    const outDir = join(base, 'site');
    await writeMarker(outDir, ['index.html', 'reading.html']);
    const page = join(outDir, 'index.html');
    await writeFile(page, 'generated', 'utf8');
    // `reading.html` is a directory, so it is nothing this generator wrote.
    const inside = await sentinel(join(outDir, 'reading.html'), 'notes.md');

    await expect(prepareOutputDirectory(outDir, projectRoot)).rejects.toThrow(/not a regular file/u);
    expect(await survives(page)).toBe('generated');
    expect(await survives(inside)).toBe('user data');
  });

  it('refuses a bundler target that is a link to a file elsewhere', async () => {
    const outDir = join(base, 'site');
    const victim = await sentinel(base, 'important.js');
    // A forged marker that omits `assets/wiki.js` must not make it unowned
    // ground that Vite is then free to write through.
    await writeMarker(outDir, ['index.html']);
    await mkdir(join(outDir, 'assets'));
    await symlink(victim, join(outDir, 'assets', 'wiki.js'));

    await expect(
      prepareOutputDirectory(outDir, projectRoot, ['assets/wiki.js']),
    ).rejects.toThrow(/not a regular file/u);
    await expect(buildSite({ projectRoot, outDir })).rejects.toThrow(/not a regular file/u);
    expect(await survives(victim)).toBe('user data');
  });

  it('refuses to overwrite a file it did not write at a destination it will generate', async () => {
    const outDir = join(base, 'site');
    await writeMarker(outDir, ['index.html']);
    const mine = await sentinel(join(outDir, 'formats'), 'pdf.html');

    await expect(
      prepareOutputDirectory(outDir, projectRoot, ['formats/pdf.html']),
    ).rejects.toThrow(/did not write it/u);
    expect(await survives(mine)).toBe('user data');
  });

  it('refuses a target that exists as a file', async () => {
    const file = await sentinel(base, 'site.html');
    await expect(prepareOutputDirectory(file, projectRoot)).rejects.toThrow(/not a directory/u);
    expect(await survives(file)).toBe('user data');
  });
});

describe('repeat builds', () => {
  it('rebuilds into its own output directory and replaces only its own files', async () => {
    const outDir = join(base, 'site');
    const first = await buildSite({ projectRoot, outDir, bundleClient: false });
    expect(first.pages.length).toBeGreaterThan(0);
    const marker = parsePortableJson(await readFile(join(outDir, OUTPUT_MARKER), 'utf8'));
    expect(marker).toMatchObject({ generator: 'interleaf-wiki-site', version: 1 });

    // Files the generator did not record are not its to delete, whether the
    // user put them there or an older tool did.
    const keep = await sentinel(outDir, 'user-notes.md');
    await writeFile(join(outDir, 'stale.html'), 'stale', 'utf8');
    const stalePage = join(outDir, 'formats', 'gone.html');
    await writeFile(stalePage, 'stale', 'utf8');

    const second = await buildSite({ projectRoot, outDir, bundleClient: false });
    expect(second.pages.length).toBe(first.pages.length);
    expect(await survives(keep)).toBe('user data');
    expect(await readFile(join(outDir, 'index.html'), 'utf8')).toContain('Interleaf');
    expect(await survives(stalePage)).toBe('stale');
  });

  it('refuses to build into a directory of unrelated files', async () => {
    const outDir = join(base, 'not-ours');
    const keep = await sentinel(outDir, 'report.pdf');
    await expect(buildSite({ projectRoot, outDir, bundleClient: false })).rejects.toThrow(/not empty/u);
    expect(await survives(keep)).toBe('user data');
  });
});
