import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import {
  OUTPUT_MARKER,
  applyDownloads,
  buildWebsite,
  parseSiteConfig,
  prepareOutputDirectory,
  renderPage,
  validateDownloadUrl,
  type SiteConfig,
} from '../../../website.build';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const websiteDir = join(projectRoot, 'website');
const UNWIRED: SiteConfig = { downloads: { 'macos-arm64': null, 'macos-x64': null } };
const ARM_URL = 'https://downloads.example.com/Interleaf-0.2.0-arm64.dmg';

async function sourceHtml(): Promise<string> {
  return readFile(join(websiteDir, 'index.html'), 'utf8');
}

let base = '';

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'interleaf-website-')));
});

afterEach(async () => {
  if (base !== '') await rm(base, { recursive: true, force: true });
});

describe('download URL validation', () => {
  it('accepts null and a plain https .dmg link', () => {
    expect(validateDownloadUrl('macos-arm64', null)).toBeNull();
    expect(validateDownloadUrl('macos-arm64', ARM_URL)).toBe(ARM_URL);
  });

  it.each([
    ['http://example.com/a.dmg'],
    ['https://user:secret@example.com/a.dmg'],
    ['https://example.com/a.zip'],
    ['javascript:alert(1)//.dmg'],
    ['/relative/Interleaf.dmg'],
    [''],
    [42],
  ])('rejects %j', (value) => {
    expect(() => validateDownloadUrl('macos-arm64', value)).toThrow();
  });

  it('requires both keys and rejects unknown ones', () => {
    expect(() => parseSiteConfig({ downloads: { 'macos-arm64': null } })).toThrow(/macos-x64/u);
    expect(() => parseSiteConfig({ downloads: { 'macos-arm64': null, 'macos-x64': null, windows: null } })).toThrow(/Unknown/u);
  });

  it('ships with both downloads unconfigured', async () => {
    const config = parseSiteConfig(JSON.parse(await readFile(join(websiteDir, 'site.config.json'), 'utf8')));
    expect(config).toEqual(UNWIRED);
  });
});

describe('download controls', () => {
  it('stays an unavailable, focusable button with no href while unconfigured', async () => {
    const { document } = parseHTML(await sourceHtml());
    expect(applyDownloads(document, UNWIRED)).toEqual([]);
    const controls = [...document.querySelectorAll('[data-download]')];
    expect(controls.length).toBeGreaterThanOrEqual(3);
    for (const control of controls) {
      expect(control.tagName).toBe('BUTTON');
      expect(control.getAttribute('aria-disabled')).toBe('true');
      expect(control.hasAttribute('href')).toBe(false);
      expect(control.hasAttribute('disabled')).toBe(false);
      const status = document.getElementById(control.getAttribute('aria-describedby') ?? '');
      expect(status?.textContent).toMatch(/Coming soon/u);
    }
    expect(document.querySelector('a[href$=".dmg"]')).toBeNull();
  });

  it('becomes a real link only for the configured build', async () => {
    const { document } = parseHTML(await sourceHtml());
    const wired = applyDownloads(document, { downloads: { 'macos-arm64': ARM_URL, 'macos-x64': null } });
    expect(wired).toEqual(['macos-arm64']);
    const links = [...document.querySelectorAll('a[data-download="macos-arm64"]')];
    expect(links.length).toBe(2);
    for (const link of links) {
      expect(link.getAttribute('href')).toBe(ARM_URL);
      expect(link.hasAttribute('aria-disabled')).toBe(false);
      expect(link.textContent).toMatch(/Apple silicon|Download for Mac/u);
    }
    expect(document.querySelector('button[data-download="macos-x64"]')?.getAttribute('aria-disabled')).toBe('true');
    // The hero note describes only the wired control; the shared note still has an unwired one.
    expect(document.getElementById('download-status-hero')?.textContent).toMatch(/Beta/u);
    expect(document.getElementById('download-status')?.textContent).toMatch(/Not every build/u);
  });
});

describe('page content', () => {
  it('references only existing local images, each with alt text and dimensions', async () => {
    const page = renderPage(await sourceHtml(), UNWIRED);
    expect(page.assets.length).toBeGreaterThan(20);
    for (const asset of page.assets) {
      expect((await stat(join(websiteDir, asset))).isFile()).toBe(true);
    }
    const { document } = parseHTML(page.html);
    for (const image of document.querySelectorAll('img')) {
      expect(image.hasAttribute('alt')).toBe(true);
      expect(Number(image.getAttribute('width'))).toBeGreaterThan(0);
      expect(Number(image.getAttribute('height'))).toBeGreaterThan(0);
    }
  });

  it('uses no inline script, inline handler or remote subresource', async () => {
    const { document } = parseHTML(await sourceHtml());
    const scripts = [...document.querySelectorAll('script')];
    expect(scripts.map((script) => script.getAttribute('src'))).toEqual(['assets/site.js']);
    expect(scripts.every((script) => script.textContent.trim() === '')).toBe(true);
    expect(document.querySelectorAll('[style]').length).toBe(0);
    for (const element of document.querySelectorAll('*')) {
      for (const name of element.getAttributeNames()) expect(name.startsWith('on')).toBe(false);
    }
    for (const element of document.querySelectorAll('[src], link[href]')) {
      const url = element.getAttribute('src') ?? element.getAttribute('href') ?? '';
      expect(url).not.toMatch(/^(?:[a-z]+:)?\/\//iu);
    }
  });

  it('labels the fixture chat answer as a sample', async () => {
    const { document } = parseHTML(await sourceHtml());
    const chat = document.getElementById('chat');
    expect(chat?.textContent).toMatch(/Sample answer from a test fixture/u);
    expect(chat?.querySelector('img')?.getAttribute('alt')).toMatch(/sample/iu);
  });

  it('credits every demo book in the footer and records its provenance', async () => {
    const manifest = JSON.parse(await readFile(join(websiteDir, 'demo-library.json'), 'utf8')) as {
      books: readonly { title: string; sha256: string; sourceUrl: string; landingUrl: string; licenseUrl: string }[];
    };
    const provenance = await readFile(join(websiteDir, 'PROVENANCE.md'), 'utf8');
    const { document } = parseHTML(await sourceHtml());
    // A native disclosure keeps the attribution reachable without the script.
    const credits = document.querySelector('.site-footer details#credits');
    expect(credits?.querySelector('summary')?.textContent).toMatch(/credits/iu);
    const titles = [...(credits?.querySelectorAll('cite') ?? [])].map((cite) => cite.textContent);
    const links = [...(credits?.querySelectorAll('a[href]') ?? [])].map((link) => link.getAttribute('href'));
    expect(manifest.books.length).toBe(4);
    for (const book of manifest.books) {
      expect(provenance).toContain(book.sha256);
      expect(provenance).toContain(book.sourceUrl);
      expect(provenance).toContain(book.licenseUrl);
      expect(titles).toContain(book.title);
      expect(links).toContain(book.landingUrl);
      expect(links).toContain(book.licenseUrl);
    }
  });

  it('points every header link at a section that exists', async () => {
    const { document } = parseHTML(await sourceHtml());
    const targets = [...document.querySelectorAll('.site-nav a')].map((link) => link.getAttribute('href') ?? '');
    expect(targets).toEqual(['#features', '#local-first', '#providers']);
    for (const target of targets) expect(document.getElementById(target.slice(1)), target).not.toBeNull();
  });

  it('keeps backdrop filters off the page, since they re-sample content on every scrolled frame', async () => {
    const css = await readFile(join(websiteDir, 'styles.css'), 'utf8');
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//gu, '');
    expect(withoutComments).not.toMatch(/backdrop-filter\s*:/u);
  });

  it('maps features to evidence files that exist', async () => {
    const map = await readFile(join(websiteDir, 'FEATURES.md'), 'utf8');
    const paths = [...new Set([...map.matchAll(/`((?:src|docs)\/[^`]+\.[a-z]+|[A-Za-z-]+\.(?:yml|json|md))`/gu)].map((match) => match[1] ?? ''))];
    expect(paths.length).toBeGreaterThan(30);
    for (const path of paths) {
      expect((await stat(join(projectRoot, path))).isFile(), path).toBe(true);
    }
  });
});

describe('build output', () => {
  it('builds a self-contained site with no personal paths in any text file', async () => {
    const outDir = join(base, 'site');
    const result = await buildWebsite({ projectRoot, outDir, config: UNWIRED, bundleClient: false });
    expect(result.wiredDownloads).toEqual([]);
    const headers = await readFile(join(outDir, '_headers'), 'utf8');
    expect(headers).toMatch(/Content-Security-Policy: default-src 'none'/u);
    expect(await readFile(join(outDir, '.assetsignore'), 'utf8')).toContain(OUTPUT_MARKER);

    const sources = ['index.html', 'styles.css', 'PROVENANCE.md', 'FEATURES.md', 'README.md', 'demo-library.json', 'wrangler.jsonc']
      .map((name) => join(websiteDir, name));
    const shipped = [join(outDir, 'index.html'), join(outDir, 'styles.css'), join(outDir, '_headers')];
    for (const file of [...sources, ...shipped, join(projectRoot, 'website.client.ts')]) {
      const text = await readFile(file, 'utf8');
      expect(text, file).not.toMatch(/\/Users\/|\/home\/[a-z]|C:\\Users\\/u);
    }
  });

  it('keeps image files free of embedded metadata text', async () => {
    const screens = join(websiteDir, 'assets', 'screens');
    for (const name of await readdir(screens)) {
      const bytes = await readFile(join(screens, name));
      expect(bytes.includes(Buffer.from('EXIF')), name).toBe(false);
      expect(bytes.includes(Buffer.from('/Users/')), name).toBe(false);
    }
  });

  it('refuses unsafe output directories without deleting anything', async () => {
    await expect(prepareOutputDirectory(projectRoot, projectRoot)).rejects.toThrow(/project root/u);
    await expect(prepareOutputDirectory(join(projectRoot, 'website'), projectRoot)).rejects.toThrow(/protected/u);
    await expect(prepareOutputDirectory(join(projectRoot, 'src', 'x'), projectRoot)).rejects.toThrow(/protected/u);

    const foreign = join(base, 'foreign');
    await mkdir(foreign);
    await writeFile(join(foreign, 'keep.txt'), 'user data', 'utf8');
    await expect(prepareOutputDirectory(foreign, projectRoot)).rejects.toThrow(/not empty/u);
    expect(await readFile(join(foreign, 'keep.txt'), 'utf8')).toBe('user data');

    const linked = join(base, 'linked');
    await symlink(foreign, linked);
    await expect(prepareOutputDirectory(join(linked, 'site'), projectRoot)).rejects.toThrow(/symbolic link/u);
  });

  it('rebuilds over its own output but leaves files it did not write', async () => {
    const outDir = join(base, 'site');
    await buildWebsite({ projectRoot, outDir, config: UNWIRED, bundleClient: false });
    await writeFile(join(outDir, 'assets', 'user-note.txt'), 'keep', 'utf8');
    await buildWebsite({ projectRoot, outDir, config: UNWIRED, bundleClient: false });
    expect(await readFile(join(outDir, 'assets', 'user-note.txt'), 'utf8')).toBe('keep');
    const marker = JSON.parse(await readFile(join(outDir, OUTPUT_MARKER), 'utf8')) as { files: string[] };
    expect(marker.files).toContain('index.html');
  });
});
