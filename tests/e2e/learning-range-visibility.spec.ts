import { expect, test, type Frame, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchInterleaf, stubOpenDialog } from './helpers';
import { makeDocxFixture, makeEpubFixture, makeMobiFixture } from '../fixtures/document-fixtures';

const PHRASE = 'UNIQUE TARGET QUOTE AT END';

async function selectQuote(frame: Page | Frame, phrase: string): Promise<void> {
  await frame.evaluate((needle) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !(node.textContent ?? '').includes(needle)) node = walker.nextNode();
    if (!node) throw new Error('Fixture quote missing');
    const offset = (node.textContent ?? '').indexOf(needle);
    const range = document.createRange();
    range.setStart(node, offset); range.setEnd(node, offset + needle.length);
    const scroll = document.querySelector<HTMLElement>('[data-testid="markdown-scroll-container"], [data-testid="docx-scroll-container"]');
    const top = range.getBoundingClientRect().top;
    if (scroll) scroll.scrollTo({ top: scroll.scrollTop + top - scroll.getBoundingClientRect().top - 24, behavior: 'instant' });
    else window.scrollTo({ top: (document.scrollingElement?.scrollTop ?? 0) + top - 24, behavior: 'instant' });
    document.getSelection()?.removeAllRanges(); document.getSelection()?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }, phrase);
}

async function position(frame: Page | Frame, phrase: string): Promise<{ readonly top: number; readonly bottom: number; readonly left: number; readonly right: number; readonly viewportTop: number; readonly viewportBottom: number; readonly viewportLeft: number; readonly viewportRight: number; readonly visible: boolean }> {
  return frame.evaluate((needle) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !(node.textContent ?? '').includes(needle)) node = walker.nextNode();
    if (!node) throw new Error('Fixture quote missing');
    const offset = (node.textContent ?? '').indexOf(needle);
    const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + needle.length);
    const rect = range.getBoundingClientRect();
    const viewport = document.querySelector<HTMLElement>('[data-testid="markdown-scroll-container"], [data-testid="docx-scroll-container"]')?.getBoundingClientRect();
    const viewportTop = viewport?.top ?? 0;
    const viewportBottom = viewport?.bottom ?? innerHeight;
    const viewportLeft = viewport?.left ?? 0;
    const viewportRight = viewport?.right ?? innerWidth;
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, viewportTop, viewportBottom, viewportLeft, viewportRight,
      visible: rect.bottom > viewportTop && rect.top < viewportBottom && rect.right > viewportLeft && rect.left < viewportRight };
  }, phrase);
}

for (const format of ['markdown', 'epub', 'mobi', 'docx'] as const) {
  test(`places the exact offscreen ${format} range after reflow`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'interleaf-learning-range-'));
    const path = join(dir, `Long.${format === 'markdown' ? 'md' : format}`);
    const content = `${Array.from({ length: format === 'markdown' || format === 'docx' ? 260 : 160 }, (_, i) => `Sentence ${String(i)} supports careful reading.`).join(' ')} ${PHRASE}`;
    const bytes = format === 'markdown' ? `# Long paragraph\n\n${content}\n`
      : format === 'epub' ? makeEpubFixture({ title: 'Long EPUB', chapters: [{ title: 'Chapter', content: `<p>${content}</p>` }] })
        : format === 'mobi' ? makeMobiFixture({ title: 'Long MOBI', chapters: [{ title: 'Chapter', content: `<p>${content}</p>` }] })
          : makeDocxFixture({ title: 'Long DOCX', bodyText: content });
    writeFileSync(path, bytes);
    const app = await launchInterleaf();
    try {
      await stubOpenDialog(app, [path]);
      await app.window.getByTestId('import-files-button').click();
      await expect(app.window.getByTestId('success-banner')).toBeVisible();
      const [doc] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
      await app.window.getByTestId(`read-doc-${doc!.id}`).click();
      if (format === 'markdown') await expect(app.window.getByTestId('markdown-content-wrapper')).toContainText(PHRASE);
      else if (format === 'docx') await expect(app.window.getByTestId('reader-view').getByText(PHRASE, { exact: false })).toBeAttached();
      else await expect(app.window.frameLocator('iframe[title="Ebook Content"]').getByText(PHRASE, { exact: false })).toBeAttached();
      const frame = format === 'markdown' || format === 'docx' ? app.window : app.window.frames().find((candidate) => candidate.parentFrame() !== null);
      if (!frame) throw new Error('Ebook frame missing');
      await selectQuote(frame, PHRASE);
      await app.window.getByRole('button', { name: 'Learning', exact: true }).click();
      const margin = app.window.getByTestId('learning-margin');
      await margin.getByLabel('Title').fill('Late source');
      await margin.getByLabel('Text').fill('Find the evidence.');
      await margin.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(margin.getByText('Find the evidence.')).toBeVisible();
      await app.electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1180, 800); });
      await expect.poll(() => app.window.evaluate(() => innerWidth)).toBe(1180);
      await frame.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>('[data-testid="markdown-scroll-container"], [data-testid="docx-scroll-container"]');
        if (scroller) scroller.scrollTo({ top: 0, behavior: 'instant' });
        else window.scrollTo({ top: 0, behavior: 'instant' });
      });
      const before = await position(frame, PHRASE);
      expect(before.visible, 'The exact quote must begin offscreen').toBe(false);
      if (process.env.INTERLEAF_LEARNING_RANGE_EVIDENCE) {
        const target = process.env.INTERLEAF_LEARNING_RANGE_EVIDENCE;
        writeFileSync(join(target, `${format}-before-position.json`), JSON.stringify(before, null, 2));
        await app.window.screenshot({ path: join(target, `${format}-before.png`) });
      }
      if (await margin.getByRole('button', { name: 'Show all learning' }).isVisible()) await margin.getByRole('button', { name: 'Show all learning' }).click();
      await margin.getByRole('button', { name: 'Open source', exact: true }).click();
      await expect(margin.getByRole('status')).toHaveText('Source opened.');
      const result = await position(frame, PHRASE);
      if (process.env.INTERLEAF_LEARNING_RANGE_EVIDENCE) {
        const target = process.env.INTERLEAF_LEARNING_RANGE_EVIDENCE;
        writeFileSync(join(target, `${format}-after-position.json`), JSON.stringify(result, null, 2));
        await app.window.screenshot({ path: join(target, `${format}-after.png`) });
      }
      expect(result.visible, 'A successful jump must expose the exact text range').toBe(true);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
