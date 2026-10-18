import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PALETTE_TOKENS } from '../../src/shared/constants/palette-tokens';
import { makeEpubFixture } from '../fixtures/document-fixtures';
import { captureWindowPng, launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { chooseListboxValue } from './listbox';

/**
 * A reader page background chosen independently of the app theme brings its
 * whole set of reading colours with it. Text, headings, links, quotes and code
 * are measured as painted, against the background they actually sit on, with a
 * light app over a dark page and the reverse; the reader toolbar stays on the
 * app theme. Screenshots are written only when an evidence directory is given.
 */

const EVIDENCE_DIR = process.env.INTERLEAF_EVIDENCE_DIR;

const MARKDOWN = [
  '# A heading on the page',
  '',
  'Ordinary body text that has to stay readable.',
  '',
  '[A link to elsewhere](https://example.com/)',
  '',
  '> A quoted passage.',
  '',
  '```js',
  'const answer = 42;',
  '```',
].join('\n');

type Pair = { readonly color: string; readonly background: string };
type Painted = Readonly<Record<'heading' | 'paragraph' | 'link' | 'quote' | 'code', Pair>>;

function rgb(hex: string): string {
  const value = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  return `rgb(${String(r)}, ${String(g)}, ${String(b)})`;
}

function luminance(color: string): number {
  const channels = (color.match(/[\d.]+/gu) ?? []).slice(0, 3).map(Number);
  const [r = 0, g = 0, b = 0] = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(pair: Pair): number {
  const [light, dark] = [luminance(pair.color), luminance(pair.background)].sort((a, b) => b - a);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

/** Each element's text colour and the first opaque background behind it. */
const readPainted = (page: Page): Promise<Painted> => page.evaluate(() => {
  const wrapper = document.querySelector('[data-testid="markdown-content-wrapper"]');
  if (wrapper === null) throw new Error('Markdown is not open.');
  const backgroundOf = (element: Element): string => {
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      const background = getComputedStyle(node).backgroundColor;
      if (background !== 'transparent' && !background.startsWith('rgba(0, 0, 0, 0)')) return background;
    }
    return 'rgb(255, 255, 255)';
  };
  const pair = (selector: string): { color: string; background: string } => {
    const element = wrapper.querySelector(selector);
    if (element === null) throw new Error(`Missing ${selector}`);
    return { color: getComputedStyle(element).color, background: backgroundOf(element) };
  };
  return { heading: pair('h1'), paragraph: pair('p'), link: pair('a'), quote: pair('blockquote'), code: pair('pre code') };
});

async function openSettingsTheme(page: Page): Promise<void> {
  await page.getByTestId('open-settings').click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await page.getByTestId('settings-rail-theme').click();
}

async function setThemes(page: Page, app: string, reader: string): Promise<void> {
  await openSettingsTheme(page);
  await page.getByTestId(`theme-option-${app}`).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', app);
  await chooseListboxValue(page.getByTestId('settings-reader-background'), reader);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
  await expect(page.locator('.reader-surface')).toHaveAttribute('data-reader-background', reader);
}

async function importAndOpen(app: AppHandle, path: string): Promise<void> {
  const page = app.window;
  await stubOpenDialog(app, [path]);
  await page.getByTestId('import-files-button').click();
  await expect(page.getByTestId('success-banner')).toBeVisible();
  const [entry] = await page.evaluate(async () => window.interleafAPI.library.listDocuments());
  if (entry === undefined) throw new Error('Fixture was not imported.');
  await page.getByTestId(`read-doc-${entry.id}`).click();
}

test.describe('Reader background with its own theme', () => {
  let app: AppHandle | undefined;
  let fixtureDir: string;

  test.beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-reader-roles-'));
  });

  test.afterEach(async () => {
    await app?.close();
    app = undefined;
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('keeps Markdown text, links, quotes and code readable in both directions', async () => {
    const markdownPath = join(fixtureDir, 'Mixed.md');
    writeFileSync(markdownPath, MARKDOWN);
    app = await launchInterleaf();
    const page = app.window;
    await importAndOpen(app, markdownPath);
    await expect(page.getByTestId('markdown-scroll-container')).toBeVisible();

    for (const [shell, reader] of [['paper', 'ink'], ['ink', 'paper']] as const) {
      await setThemes(page, shell, reader);
      const tokens = PALETTE_TOKENS[reader];
      // The page has settled on the reader palette once its body text has.
      await expect.poll(async () => (await readPainted(page)).paragraph)
        .toEqual({ color: rgb(tokens['text-primary']), background: rgb(tokens['bg-reader']) });
      const painted = await readPainted(page);
      for (const role of ['heading', 'paragraph', 'link', 'quote'] as const) {
        expect(contrast(painted[role]), `${role} on a ${reader} page in the ${shell} app`).toBeGreaterThanOrEqual(7);
      }
      expect(contrast(painted.code), `code on a ${reader} page in the ${shell} app`).toBeGreaterThanOrEqual(4.5);
      expect(painted.link.color).toBe(rgb(tokens.accent));

      // The reader toolbar is app chrome and stays on the app theme.
      const toolbar = await page.getByTestId('reader-header-toolbar')
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(toolbar).toBe(rgb(PALETTE_TOKENS[shell]['bg-primary']));

      if (EVIDENCE_DIR !== undefined && EVIDENCE_DIR.length > 0) {
        await captureWindowPng(app, join(EVIDENCE_DIR, `${shell}-shell-${reader}-reader.png`));
      }
    }
  });

  test('gives an EPUB page the reader theme’s accent and readable anchors in both directions', async () => {
    const epubPath = join(fixtureDir, 'Linked.epub');
    writeFileSync(epubPath, makeEpubFixture({
      title: 'Linked',
      author: 'Interleaf',
      chapters: [{
        title: 'Chapter 1',
        content: '<p>Before the link. <a id="jump" href="#target">Jump to the note</a></p><p id="target">The note.</p>',
      }],
    }));
    app = await launchInterleaf();
    const page = app.window;
    await importAndOpen(app, epubPath);
    const frame = page.frameLocator('iframe[title="Ebook Content"]');
    await expect(frame.getByText('Before the link.')).toBeVisible();

    for (const [shell, reader] of [['paper', 'ink'], ['ink', 'paper']] as const) {
      await setThemes(page, shell, reader);
      const tokens = PALETTE_TOKENS[reader];
      await expect.poll(() => frame.locator('body').evaluate((body) => getComputedStyle(body).backgroundColor))
        .toBe(rgb(tokens['bg-reader']));
      // The frame's accent token is the reader page's, not the app's.
      await expect.poll(() => frame.locator('html').evaluate((root) => getComputedStyle(root).getPropertyValue('--accent').trim()))
        .toBe(tokens.accent);
      // Book links are sanitised to inert text, so an anchor reads as body text.
      const anchor = await frame.locator('#jump').evaluate((link) => getComputedStyle(link).color);
      expect(anchor).toBe(rgb(tokens['text-primary']));
      expect(contrast({ color: anchor, background: rgb(tokens['bg-reader']) })).toBeGreaterThanOrEqual(7);
    }
  });
});
