import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { OUTPUT_MARKER, buildSite, renderMarkdown } from '../../../wiki.build';
import {
  IMAGE_SOURCE_DIR,
  MAX_IMAGE_BYTES,
  imageNameFor,
  imageSources,
  placeImages,
  readWikiImage,
} from '../../../wiki.images';
import { parsePortableJson } from '@shared/models/portable';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const SHOT = 'library-1600.webp';
/** The smallest bytes `readWikiImage` accepts as a WebP file. */
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);

/**
 * Fixtures live in a canonical temporary directory of this test's own making;
 * nothing here writes to the repository or to a real user directory.
 */
let base = '';

beforeEach(async () => {
  // `realpath` because macOS exposes the temporary directory through symlinks.
  base = await realpath(await mkdtemp(join(tmpdir(), 'interleaf-wiki-img-')));
});

afterEach(async () => {
  if (base !== '') await rm(base, { recursive: true, force: true });
});

/** A project root with only the screenshot directory, holding `files`. */
async function screenshotRoot(files: Readonly<Record<string, Buffer>>): Promise<string> {
  const root = join(base, 'project');
  const screens = join(root, ...IMAGE_SOURCE_DIR.split('/'));
  await mkdir(screens, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(screens, name), bytes);
  return root;
}

/**
 * A minimal copy of the project the wiki builds from: every page, the
 * stylesheet, and the real screenshots. Tests then change one thing in it.
 */
async function wikiProject(): Promise<string> {
  const root = join(base, 'wiki-project');
  const sources = ['docs/wiki', 'wiki-site/styles.css', IMAGE_SOURCE_DIR,
    'docs/ARCHITECTURE.md', 'docs/SECURITY.md', 'docs/AI_ARCHITECTURE.md',
    'docs/AGENT_RUNTIME.md', 'docs/DOCUMENT_FORMATS.md', 'docs/PACKAGING.md'];
  for (const source of sources) {
    await cp(join(projectRoot, source), join(root, source), { recursive: true });
  }
  return root;
}

describe('image references', () => {
  it('accepts an allowlisted screenshot from top-level and nested pages', () => {
    expect(imageNameFor(`../../${IMAGE_SOURCE_DIR}/${SHOT}`, 'wiki/reading.md')).toBe(SHOT);
    expect(imageNameFor(`../../../${IMAGE_SOURCE_DIR}/${SHOT}`, 'wiki/formats/epub.md')).toBe(SHOT);
  });

  it.each([
    'https://example.com/library.webp',
    'http://example.com/library.webp',
    'https://user:secret@example.com/library.webp',
    '//example.com/library.webp',
    'data:image/png;base64,iVBORw0KGgo=',
    'javascript:alert(1)',
    'file:///etc/passwd',
    `/${IMAGE_SOURCE_DIR}/${SHOT}`,
    `..\\..\\website\\assets\\screens\\${SHOT}`,
    `%2e%2e/%2e%2e/${IMAGE_SOURCE_DIR}/${SHOT}`,
    `../../${IMAGE_SOURCE_DIR}/${SHOT}?v=1`,
    `../../${IMAGE_SOURCE_DIR}/${SHOT}#top`,
    `../../${IMAGE_SOURCE_DIR}/../../../secret.webp`,
    `../../../../${IMAGE_SOURCE_DIR}/${SHOT}`,
    '../../website/assets/brand/interleaf-icon-64.png',
    `../../${IMAGE_SOURCE_DIR}/nested/${SHOT}`,
    `../../${IMAGE_SOURCE_DIR}/diagram.svg`,
    `../../${IMAGE_SOURCE_DIR}/Library.webp`,
    `../../${IMAGE_SOURCE_DIR}/.hidden.webp`,
    SHOT,
  ])('rejects %s', (src) => {
    expect(() => imageNameFor(src, 'wiki/reading.md')).toThrow(/Wiki images must/u);
  });

  it('finds inline and reference-style images but not raw HTML', () => {
    const markdown = [
      '![Inline](a.webp) and ![Ref][shot]',
      '',
      '<img src="raw.webp">',
      '',
      '[shot]: b.webp',
    ].join('\n');
    expect(imageSources(markdown)).toEqual(['a.webp', 'b.webp']);
  });
});

describe('rendering', () => {
  it('drops remote and scripted images and never passes raw HTML images through', () => {
    const html = renderMarkdown([
      '![remote](https://example.com/x.png)',
      '![script](javascript:alert(1))',
      '![protocol](//example.com/x.png)',
      '<img src="x.webp" onerror="alert(1)">',
    ].join('\n\n'));
    expect(html).not.toContain('<img');
    // The raw tag survives only as escaped, inert text.
    expect(html).toContain('&lt;img src="x.webp" onerror="alert(1)"&gt;');
  });

  it('turns an image with an italic caption into a figure and links it relative to the page', () => {
    const src = `../../../${IMAGE_SOURCE_DIR}/${SHOT}`;
    const html = renderMarkdown(`![The library](${src})\n*Demo library.*\n\n- ![inline](${src})\n\n![stray](other.webp)`);
    const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
    placeImages(document.body, document, new Map([[src, SHOT]]), (name) => `../assets/screens/${name}`);

    const figure = document.querySelector('figure.wiki-figure');
    expect(figure?.querySelector('img')?.getAttribute('src')).toBe(`../assets/screens/${SHOT}`);
    expect(figure?.querySelector('img')?.getAttribute('alt')).toBe('The library');
    expect(figure?.querySelector('figcaption')?.textContent).toBe('Demo library.');
    expect(figure?.querySelector('img')?.getAttribute('loading')).toBe('lazy');
    // An image inside other content is kept in place, not made a figure.
    expect(document.querySelector('li img')?.getAttribute('src')).toBe(`../assets/screens/${SHOT}`);
    // An image the build did not validate is removed.
    expect(document.querySelectorAll('img')).toHaveLength(2);
  });
});

describe('reading screenshots', () => {
  it('reads a regular screenshot whose contents match its type', async () => {
    const root = await screenshotRoot({ [SHOT]: WEBP });
    expect(await readWikiImage(root, SHOT)).toEqual(WEBP);
  });

  it('refuses unsafe names, mismatched contents and oversized files', async () => {
    const root = await screenshotRoot({
      'fake.webp': Buffer.from('<svg onload="alert(1)"></svg>'),
      'huge.webp': Buffer.concat([WEBP, Buffer.alloc(MAX_IMAGE_BYTES)]),
    });
    await expect(readWikiImage(root, '../secret.webp')).rejects.toThrow(/unsafe/u);
    await expect(readWikiImage(root, 'fake.webp')).rejects.toThrow(/do not match/u);
    await expect(readWikiImage(root, 'huge.webp')).rejects.toThrow(/regular file/u);
  });

  it('refuses a screenshot that is a symbolic link or sits behind one', async () => {
    const outside = join(base, 'outside.webp');
    await writeFile(outside, WEBP);
    const root = await screenshotRoot({});
    await symlink(outside, join(root, ...IMAGE_SOURCE_DIR.split('/'), SHOT));
    await expect(readWikiImage(root, SHOT)).rejects.toThrow();

    const linkedRoot = join(base, 'linked');
    await mkdir(join(linkedRoot, 'website', 'assets'), { recursive: true });
    await symlink(join(root, ...IMAGE_SOURCE_DIR.split('/')), join(linkedRoot, ...IMAGE_SOURCE_DIR.split('/')));
    await expect(readWikiImage(linkedRoot, SHOT)).rejects.toThrow(/not a plain directory/u);
  });
});

describe('building with screenshots', () => {
  it('copies exactly the screenshots pages use and records them for cleanup', async () => {
    const outDir = join(base, 'site');
    const result = await buildSite({ projectRoot, outDir, bundleClient: false });
    const used = [...new Set(result.pages.flatMap((page) => page.images))].sort();
    expect(used.length).toBeGreaterThan(0);
    expect((await readdir(join(outDir, 'assets', 'screens'))).sort()).toEqual(used);
    for (const name of used) {
      expect(await readFile(join(outDir, 'assets', 'screens', name)))
        .toEqual(await readFile(join(projectRoot, ...IMAGE_SOURCE_DIR.split('/'), name)));
    }
    const marker = parsePortableJson(await readFile(join(outDir, OUTPUT_MARKER), 'utf8')) as { files: string[] };
    for (const name of used) expect(marker.files).toContain(`assets/screens/${name}`);

    // Nested pages link one level up; top-level pages link from the root.
    const nested = result.pages.find((page) => page.route.includes('/') && page.images.length > 0);
    expect(nested?.html).toMatch(/src="\.\.\/assets\/screens\/[a-z0-9-]+\.webp"/u);
    const top = result.pages.find((page) => !page.route.includes('/') && page.images.length > 0);
    expect(top?.html).toMatch(/src="assets\/screens\/[a-z0-9-]+\.webp"/u);
    for (const page of result.pages) expect(page.html).not.toMatch(/<img[^>]+src="(?:https?:|\/\/|\/)/u);
  });

  it('removes screenshots an earlier build wrote and keeps files it did not', async () => {
    const outDir = join(base, 'site');
    await buildSite({ projectRoot, outDir, bundleClient: false });
    const markerPath = join(outDir, OUTPUT_MARKER);
    const marker = parsePortableJson(await readFile(markerPath, 'utf8')) as { files: string[] };
    const stale = join(outDir, 'assets', 'screens', 'retired-shot.webp');
    await writeFile(stale, WEBP);
    await writeFile(markerPath, JSON.stringify({ ...marker, files: [...marker.files, 'assets/screens/retired-shot.webp'] }));
    const userFile = join(outDir, 'assets', 'screens', 'user-notes.txt');
    await writeFile(userFile, 'user data', 'utf8');

    await buildSite({ projectRoot, outDir, bundleClient: false });
    await expect(readFile(stale)).rejects.toThrow();
    expect(await readFile(userFile, 'utf8')).toBe('user data');
  });

  it('refuses to write a screenshot through a link planted in the output', async () => {
    const outDir = join(base, 'site');
    const first = await buildSite({ projectRoot, outDir, bundleClient: false });
    const name = first.pages.flatMap((page) => page.images)[0] ?? SHOT;
    const victim = join(base, 'victim.txt');
    await writeFile(victim, 'user data', 'utf8');
    const target = join(outDir, 'assets', 'screens', name);
    await rm(target);
    await symlink(victim, target);

    await expect(buildSite({ projectRoot, outDir, bundleClient: false })).rejects.toThrow(/not a regular file/u);
    expect(await readFile(victim, 'utf8')).toBe('user data');
  });

  it('fails on a remote image before touching the previous site', async () => {
    const root = await wikiProject();
    const outDir = join(base, 'site');
    await buildSite({ projectRoot: root, outDir, bundleClient: false });
    const before = await readFile(join(outDir, 'index.html'), 'utf8');
    const page = join(root, 'docs', 'wiki', 'faq.md');
    await writeFile(page, `${await readFile(page, 'utf8')}\n![tracker](https://example.com/pixel.png)\n`);

    await expect(buildSite({ projectRoot: root, outDir, bundleClient: false })).rejects.toThrow(/local screenshots/u);
    expect(await readFile(join(outDir, 'index.html'), 'utf8')).toBe(before);
  });

  it('fails when the screenshot directory is replaced by a link', async () => {
    const root = await wikiProject();
    const screens = join(root, ...IMAGE_SOURCE_DIR.split('/'));
    const elsewhere = join(base, 'elsewhere');
    await cp(screens, elsewhere, { recursive: true });
    await rm(screens, { recursive: true });
    await symlink(elsewhere, screens);

    await expect(buildSite({ projectRoot: root, outDir: join(base, 'site'), bundleClient: false }))
      .rejects.toThrow(/not a plain directory/u);
  });
});
