import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchInterleaf, returnToLibrary, stubOpenDialog } from './helpers';
import { makeDocxFixture, makeEpubFixture, makeMobiFixture, makePdfFixture } from '../fixtures/document-fixtures';
import { makePptxFixture } from '../fixtures/pptx-fixtures';

async function selectPassage(page: Page, text: string): Promise<void> {
  await expect(page.getByTestId('markdown-content-wrapper')).toContainText(text);
  await page.evaluate((needle) => {
    const block = [...document.querySelectorAll<HTMLElement>('[data-markdown-block]')].find((element) => element.textContent.includes(needle));
    if (!block) throw new Error('Fixture passage not found');
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.textContent?.includes(needle)) node = walker.nextNode();
    if (!node) throw new Error('Fixture text node not found');
    const start = node.textContent?.indexOf(needle) ?? -1;
    const range = document.createRange();
    range.setStart(node, start); range.setEnd(node, start + needle.length);
    const selection = window.getSelection();
    selection?.removeAllRanges(); selection?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }, text);
  await expect(page.getByTestId('annotation-selection-toolbar')).toBeVisible();
}

test('authors source-linked learning in the reader and persists it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'interleaf-learning-'));
  const fixture = join(dir, 'Reading and learning.md');
  writeFileSync(fixture, '# Reading and learning\n\nA source passage gives readers evidence to consider.\n\n## Section checkpoint\n\nA second passage can challenge the first.\n');
  let app = await launchInterleaf();
  const userDataDir = app.userDataDir;
  try {
    await stubOpenDialog(app, [fixture]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [document] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    await app.window.getByTestId(`read-doc-${document!.id}`).click();
    await expect(app.window.getByTestId('markdown-content-wrapper')).toBeVisible();
    await selectPassage(app.window, 'A source passage gives readers evidence to consider.');
    await app.window.getByRole('button', { name: 'Learning', exact: true }).focus();
    await app.window.keyboard.press('Enter');
    let margin = app.window.getByTestId('learning-margin');
    await margin.getByLabel('Title').fill('Why does this matter?');
    await margin.getByLabel('Text').fill('Consider the evidence.');
    await margin.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(margin.getByText('Consider the evidence.')).toBeVisible();
    if (process.env.INTERLEAF_LEARNING_SCREENSHOT) await app.window.screenshot({ path: process.env.INTERLEAF_LEARNING_SCREENSHOT });
    await app.close({ preserveUserData: true });
    app = await launchInterleaf({ userDataDir });
    await app.window.getByTestId(`read-doc-${document!.id}`).click();
    margin = app.window.getByTestId('learning-margin');
    await expect(margin.getByText('Consider the evidence.')).toBeVisible();
    await margin.getByRole('button', { name: 'Open source', exact: true }).click();
    await expect(margin.getByRole('status')).toHaveText('Source opened.');
    await margin.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(margin.getByText('Passage question · Dismissed')).toBeVisible();
    await expect(app.window.locator('[data-reader-focus-target="true"]')).toBeFocused();
    await margin.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(margin.getByText('Consider the evidence.')).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});


test('retains a conflict draft across documents and opens its second source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'interleaf-learning-conflict-'));
  const firstPath = join(dir, 'First.md');
  const secondPath = join(dir, 'Second.md');
  writeFileSync(firstPath, '# First\n\nFirst source argues one position.\n');
  writeFileSync(secondPath, '# Second\n\nSecond source argues another position.\n');
  const app = await launchInterleaf();
  try {
    await stubOpenDialog(app, [firstPath, secondPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const documents = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    const first = documents.find((entry) => entry.title === 'First');
    const second = documents.find((entry) => entry.title === 'Second');
    expect(first).toBeDefined(); expect(second).toBeDefined();
    await app.window.getByTestId(`read-doc-${first!.id}`).click();
    await selectPassage(app.window, 'First source argues one position.');
    await app.window.getByRole('button', { name: 'Learning', exact: true }).click();
    let margin = app.window.getByTestId('learning-margin');
    await margin.getByRole('combobox', { name: 'Kind' }).click();
    await app.window.getByRole('option', { name: 'Conflict prompt' }).click();
    await margin.getByLabel('Title').fill('Compare claims');
    await margin.getByLabel('Text').fill('Where do the claims disagree?');
    await returnToLibrary(app);
    await app.window.getByTestId(`read-doc-${second!.id}`).click();
    await selectPassage(app.window, 'Second source argues another position.');
    await app.window.getByRole('button', { name: 'Learning', exact: true }).click();
    margin = app.window.getByTestId('learning-margin');
    await expect(margin.getByText(/Second source:/)).toBeVisible();
    await expect(margin.getByLabel('Title')).toHaveValue('Compare claims');
    await margin.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(margin.getByRole('status')).toHaveText('Learning item saved.');
    await returnToLibrary(app);
    await app.window.getByTestId(`read-doc-${first!.id}`).click();
    margin = app.window.getByTestId('learning-margin');
    await expect(margin.getByText('Where do the claims disagree?')).toBeVisible();
    await expect(margin.getByText('Second', { exact: true })).toBeVisible();
    if (process.env.INTERLEAF_LEARNING_CONFLICT_SCREENSHOT) await app.window.screenshot({ path: process.env.INTERLEAF_LEARNING_CONFLICT_SCREENSHOT });
    await margin.getByRole('button', { name: 'Open other source' }).click();
    await expect(app.window.getByTestId('reader-view')).toHaveAttribute('data-document-id', second!.id);
    await expect(app.window.getByRole('status').filter({ hasText: 'Source opened.' })).toBeVisible();
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const format of ['pdf', 'epub', 'mobi', 'docx', 'pptx'] as const) {
  test(`creates and resolves a ${format.toUpperCase()} learning source`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'interleaf-learning-format-'));
    const filePath = join(dir, `Learning.${format}`);
    const phrase = 'A unique passage for careful reading.';
    const bytes = format === 'pdf'
      ? makePdfFixture({ title: 'Learning PDF', pageLines: [[phrase]] })
      : format === 'epub'
        ? makeEpubFixture({ title: 'Learning EPUB', chapters: [{ title: 'Chapter', content: `<p>${phrase}</p>` }] })
        : format === 'mobi'
          ? makeMobiFixture({ title: 'Learning MOBI', chapters: [{ title: 'Chapter', content: `<p>${phrase}</p>` }] })
          : format === 'docx'
            ? makeDocxFixture({ title: 'Learning DOCX', bodyText: phrase })
            : makePptxFixture({ title: 'Learning PPTX', slides: [{ title: 'Slide', textBox: phrase }] });
    writeFileSync(filePath, bytes);
    const app = await launchInterleaf();
    try {
      await stubOpenDialog(app, [filePath]);
      await app.window.getByTestId('import-files-button').click();
      await expect(app.window.getByTestId('success-banner')).toBeVisible();
      const [openedDocument] = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
      await app.window.getByTestId(`read-doc-${openedDocument!.id}`).click();
      if (format === 'pdf') await expect(app.window.getByTestId('pdf-textlayer-p1')).toContainText(phrase);
      else if (format === 'epub' || format === 'mobi') await expect(app.window.frameLocator('iframe[title="Ebook Content"]').getByText(phrase)).toBeVisible();
      else await expect(app.window.getByTestId('reader-view').getByText(phrase)).toBeVisible();
      const frame = format === 'epub' || format === 'mobi' ? app.window.frames().find((candidate) => candidate.parentFrame() !== null) : app.window;
      if (!frame) throw new Error('Missing ebook frame');
      await frame.evaluate((needle) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node && !node.textContent?.includes(needle)) node = walker.nextNode();
        if (!node) throw new Error('Passage unavailable');
        const start = node.textContent?.indexOf(needle) ?? -1;
        const range = document.createRange();
        range.setStart(node, start); range.setEnd(node, start + needle.length);
        document.getSelection()?.removeAllRanges(); document.getSelection()?.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
      }, phrase);
      await app.window.getByRole('button', { name: 'Learning', exact: true }).click();
      const margin = app.window.getByTestId('learning-margin');
      await margin.getByLabel('Title').fill('Read closely');
      await margin.getByLabel('Text').fill('What follows?');
      await margin.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(margin.getByText('What follows?')).toBeVisible();
      await margin.getByRole('button', { name: 'Open source', exact: true }).click();
      await expect(margin.getByRole('status')).toHaveText('Source opened.');
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
