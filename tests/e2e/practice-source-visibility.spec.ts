import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Frame, type Page } from '@playwright/test';
import { makeEpubFixture, makeMobiFixture, makeMarkdownFixture, makePdfFixture } from '../fixtures/document-fixtures';
import { launchInterleaf, returnToLibrary, stubOpenDialog } from './helpers';
import { verifyRepeatedPracticeSource } from './practice-repeat-check';

const PHRASE = 'UNIQUE PRACTICE TARGET AT END';
const EVIDENCE = process.env.INTERLEAF_PRACTICE_SOURCE_EVIDENCE;

type ReaderFrame = Page | Frame;

async function selectTarget(frame: ReaderFrame): Promise<void> {
  await frame.evaluate((needle) => {
    const root = document.querySelector('[data-testid="markdown-content-wrapper"]') ?? document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !(node.textContent ?? '').includes(needle)) node = walker.nextNode();
    if (!node) throw new Error('Fixture quote absent');
    const start = (node.textContent ?? '').indexOf(needle);
    const range = document.createRange();
    range.setStart(node, start); range.setEnd(node, start + needle.length);
    node.parentElement?.scrollIntoView({ block: 'end' });
    document.getSelection()?.removeAllRanges(); document.getSelection()?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }, PHRASE);
}

async function quotePosition(frame: ReaderFrame) {
  return frame.evaluate((needle) => {
    const root = document.querySelector('[data-testid="markdown-content-wrapper"]') ?? document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !(node.textContent ?? '').includes(needle)) node = walker.nextNode();
    if (!node) throw new Error('Fixture quote absent');
    const start = (node.textContent ?? '').indexOf(needle);
    const range = document.createRange();
    range.setStart(node, start); range.setEnd(node, start + needle.length);
    const quote = range.getBoundingClientRect();
    const viewport = document.querySelector('[data-testid="markdown-scroll-container"]')?.getBoundingClientRect();
    const top = viewport?.top ?? 0;
    const bottom = viewport?.bottom ?? innerHeight;
    return { quoteTop: quote.top, quoteBottom: quote.bottom, viewportTop: top, viewportBottom: bottom,
      visible: quote.bottom > top && quote.top < bottom };
  }, PHRASE);
}

for (const format of ['markdown', 'epub', 'mobi'] as const) {
  for (const reflow of [false, true]) test(`practice source shows the actual quote in a long ${format} passage${reflow ? ' after reflow' : ''}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'interleaf-practice-long-'));
    const body = Array.from({ length: 160 }, (_, index) => `Context sentence ${String(index)} supports careful reading.`).join(' ') + ` ${PHRASE}`;
    const file = join(dir, `Long.${format === 'markdown' ? 'md' : format}`);
    const document = format === 'markdown' ? makeMarkdownFixture({ title: 'Long markdown', body: `# Long markdown\n\n${body}` })
      : (format === 'epub' ? makeEpubFixture : makeMobiFixture)({ title: `Long ${format}`, chapters: [{ title: 'Chapter', content: `<p>${body}</p>` }] });
    writeFileSync(file, document);
    const app = await launchInterleaf();
    try {
      await stubOpenDialog(app, [file]);
      await app.window.getByTestId('import-files-button').click();
      await expect(app.window.getByTestId('success-banner')).toBeVisible();
      const [doc] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
      if (!doc) throw new Error('Fixture document not imported');
      await app.window.getByTestId(`read-doc-${doc.id}`).click();
      if (format === 'markdown') await expect(app.window.getByTestId('markdown-content-wrapper')).toContainText(PHRASE);
      else await expect(app.window.frameLocator('iframe[title="Ebook Content"]').getByText(PHRASE, { exact: false })).toBeAttached();
      const frame = (): ReaderFrame => {
        if (format === 'markdown') return app.window;
        const child = app.window.frames().find((item) => item.parentFrame() !== null);
        if (!child) throw new Error('Ebook frame not mounted');
        return child;
      };
      await selectTarget(frame());
      const toolbar = app.window.getByTestId('annotation-selection-toolbar');
      await expect(toolbar).toBeVisible();
      await toolbar.getByRole('button', { name: 'Yellow highlight', exact: true }).click();
      await expect.poll(() => app.window.evaluate((id) => window.interleafAPI.annotations.list(id), doc.id)).toHaveLength(1);
      await app.window.locator('#companion-tab-annotations').click();
      await app.window.getByRole('button', { name: 'Make practice card' }).click();
      await app.window.getByLabel('Question', { exact: true }).fill('Where is the late quote?');
      await app.window.getByRole('button', { name: 'Save card', exact: true }).click();
      await expect(app.window.getByText('Practice card saved.')).toBeVisible();
      const [savedCard] = await app.window.evaluate(() => window.interleafAPI.practice.due(20));
      if (savedCard?.source.kind !== 'native') throw new Error('Native card was not saved');
      await returnToLibrary(app);
      await app.window.getByRole('button', { name: 'Review practice', exact: true }).click();
      if (reflow) {
        const browserWindow = await app.electronApp.browserWindow(app.window);
        await browserWindow.evaluate((win) => { win.unmaximize(); win.setSize(1000, 700); });
        await expect.poll(() => browserWindow.evaluate((win) => { const { width } = win.getBounds(); return width === 1000; })).toBe(true);
      }
      await app.window.getByLabel('Your answer').fill('At the end');
      await app.window.getByRole('button', { name: 'Reveal source', exact: true }).click();
      await app.window.getByRole('button', { name: 'Open source passage', exact: true }).click();
      await expect(app.window.getByText('Source passage opened.', { exact: true })).toBeVisible();
      const position = await quotePosition(frame());
      if (EVIDENCE) {
        mkdirSync(EVIDENCE, { recursive: true });
        writeFileSync(join(EVIDENCE, `${format}${reflow ? "-reflow" : ""}-position.json`), JSON.stringify(position, null, 2));
        await app.window.screenshot({ path: join(EVIDENCE, `${format}${reflow ? "-reflow" : ""}-source.png`) });
      }
      expect(position.visible, 'Opening the source must position the actual quote in the viewport').toBe(true);
      await verifyRepeatedPracticeSource({ app, documentId: doc.id, savedCard, format, reflow, evidenceDir: EVIDENCE, frame, quotePosition });
    } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test('an unresolved saved quote reports failure instead of announcing a passage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'interleaf-practice-missing-'));
  const file = join(dir, 'Missing.md');
  writeFileSync(file, makeMarkdownFixture({ title: 'Missing', body: '# Missing\n\nDifferent text is present.' }));
  const app = await launchInterleaf();
  try {
    await stubOpenDialog(app, [file]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [doc] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    if (!doc) throw new Error('Fixture document not imported');
    // Exercise an adversarial persisted anchor: schema-valid but absent from the real document.
    await app.window.evaluate(async (id) => {
      const annotation = await window.interleafAPI.annotations.create({ documentId: id, type: 'highlight', color: 'yellow', selectedText: 'Absent source',
        anchor: { format: 'markdown', blockIndex: 1, quote: { exact: 'Absent source', prefix: '', suffix: '' } } });
      await window.interleafAPI.practice.create({ documentId: id, annotationId: annotation.id, question: 'What is absent?' });
    }, doc.id);
    await app.window.getByRole('button', { name: 'Review practice', exact: true }).click();
    await app.window.getByLabel('Your answer').fill('Absent source');
    await app.window.getByRole('button', { name: 'Reveal source', exact: true }).click();
    await app.window.getByRole('button', { name: 'Open source passage', exact: true }).click();
    await expect(app.window.getByRole('alert')).toContainText('The source passage could not be resolved');
    await expect(app.window.getByText('Source passage opened.', { exact: true })).toHaveCount(0);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});


test('a PDF practice card opens its actual live text range', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'interleaf-practice-pdf-'));
  const file = join(dir, 'Passage.pdf');
  const phrase = 'Deep exact annotation target for centered navigation.';
  writeFileSync(file, makePdfFixture({ title: 'PDF passage', pageLines: [[
    ...Array.from({ length: 28 }, (_, index) => `Reliability design detail ${String(index + 1)}.`),
    phrase, ...Array.from({ length: 5 }, (_, index) => `Closing detail ${String(index + 1)}.`),
  ]] }));
  const app = await launchInterleaf();
  try {
    await stubOpenDialog(app, [file]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [doc] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    if (!doc) throw new Error('Fixture document not imported');
    await app.window.getByTestId(`read-doc-${doc.id}`).click();
    const layer = app.window.getByTestId('pdf-textlayer-p1');
    await expect(layer).toContainText(phrase);
    await layer.evaluate((element, needle) => {
      const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && !(node.textContent ?? '').includes(needle)) node = walker.nextNode();
      if (!node) throw new Error('PDF source text is absent');
      const start = (node.textContent ?? '').indexOf(needle);
      const range = element.ownerDocument.createRange();
      range.setStart(node, start); range.setEnd(node, start + needle.length);
      node.parentElement?.scrollIntoView({ block: 'center' });
      element.ownerDocument.getSelection()?.removeAllRanges();
      element.ownerDocument.getSelection()?.addRange(range);
      element.ownerDocument.dispatchEvent(new Event('selectionchange'));
    }, phrase);
    await app.window.getByTestId('annotation-selection-toolbar').getByRole('button', { name: 'Yellow highlight' }).click();
    await expect.poll(() => app.window.evaluate((id) => window.interleafAPI.annotations.list(id), doc.id)).toHaveLength(1);
    await app.window.locator('#companion-tab-annotations').click();
    await app.window.getByRole('button', { name: 'Make practice card' }).click();
    await app.window.getByLabel('Question', { exact: true }).fill('Where is the target?');
    await app.window.getByRole('button', { name: 'Save card', exact: true }).click();
    await expect(app.window.getByText('Practice card saved.')).toBeVisible();
    await returnToLibrary(app);
    await app.window.getByRole('button', { name: 'Review practice', exact: true }).click();
    await app.window.getByLabel('Your answer').fill('In the PDF');
    await app.window.getByRole('button', { name: 'Reveal source', exact: true }).click();
    await app.window.getByRole('button', { name: 'Open source passage', exact: true }).click();
    await expect(app.window.getByText('Source passage opened.', { exact: true })).toBeVisible();
    const position = await app.window.getByTestId('pdf-textlayer-p1').evaluate((element, needle) => {
      const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && !(node.textContent ?? '').includes(needle)) node = walker.nextNode();
      if (!node) throw new Error('PDF source text is absent');
      const start = (node.textContent ?? '').indexOf(needle);
      const range = element.ownerDocument.createRange();
      range.setStart(node, start); range.setEnd(node, start + needle.length);
      const quote = range.getBoundingClientRect();
      const viewport = element.ownerDocument.querySelector('[data-testid="pdf-scroll-container"]')?.getBoundingClientRect();
      if (!viewport) throw new Error('PDF viewport is absent');
      return { quoteTop: quote.top, quoteBottom: quote.bottom, viewportTop: viewport.top, viewportBottom: viewport.bottom,
        visible: quote.bottom > viewport.top && quote.top < viewport.bottom };
    }, phrase);
    if (EVIDENCE) {
      mkdirSync(EVIDENCE, { recursive: true });
      writeFileSync(join(EVIDENCE, 'pdf-position.json'), JSON.stringify(position, null, 2));
      await app.window.screenshot({ path: join(EVIDENCE, 'pdf-source.png') });
    }
    expect(position.visible).toBe(true);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
