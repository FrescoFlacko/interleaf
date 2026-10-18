import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  launchInterleaf,
  returnToLibrary,
  stubOpenDialog,
  type AppHandle,
} from './helpers';
import { makeMarkdownFixture } from '../fixtures/document-fixtures';

/**
 * A Markdown table renders as one `[data-markdown-block]` wrapper with one
 * `.markdown-block-content` span per cell. Measuring a selection against the
 * first of those spans left every other cell with no reported selection, so the
 * highlight/note/Ask AI toolbar never appeared for text inside a table. These
 * tests exercise the real Electron reader against a synthetic local standings
 * table; the document the defect was reported against is not in this repository.
 */
test.describe('Markdown table selection and annotations', () => {
  let app: AppHandle;
  let fixtureDir: string;
  let mdPath: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-md-table-e2e-'));
    mdPath = join(fixtureDir, 'League_Standings.md');
    writeFileSync(
      mdPath,
      makeMarkdownFixture({
        title: 'League Standings',
        author: 'Test Author',
        useFrontmatter: false,
        body: `# League Standings

Season results are tracked per team.

| Team | Wins | Notes |
| --- | --- | --- |
| Black Mambas | 12 | **Streak** of six |
| River Kings | 9 | Rebuilding |

Standings are updated after every fixture.
`,
      })
    );

    app = await launchInterleaf();
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  /** Imports the fixture and opens it in the reader, returning its id. */
  async function openFixture(): Promise<string> {
    await stubOpenDialog(app, [mdPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [document] = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    await app.window.getByTestId(`read-doc-${document!.id}`).click();
    await expect(app.window.getByTestId('reader-view')).toBeVisible();
    await expect(app.window.locator('.markdown-table').first()).toBeVisible();
    return document!.id;
  }

  /**
   * Sweeps a table cell the way a reader does and returns the platform's own
   * selection string. `cell` is `null` for a header cell, otherwise the body row.
   */
  async function selectCell(row: number | null, column: number): Promise<string> {
    return app.window.evaluate(({ rowIndex, columnIndex }) => {
      const table = document.querySelector('.markdown-table')!;
      const cell = rowIndex === null
        ? table.querySelectorAll('thead th')[columnIndex]!
        : table.querySelectorAll('tbody tr')[rowIndex]!.querySelectorAll('td')[columnIndex]!;
      const range = document.createRange();
      range.selectNodeContents(cell.querySelector('.markdown-block-content')!);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return selection.toString();
    }, { rowIndex: row, columnIndex: column });
  }

  /** Sweeps from one body cell into another in the same row. */
  async function selectAcrossRowCells(row: number, from: number, to: number): Promise<string> {
    return app.window.evaluate(({ rowIndex, fromColumn, toColumn }) => {
      const cells = document
        .querySelectorAll('.markdown-table tbody tr')[rowIndex]!
        .querySelectorAll('td');
      const range = document.createRange();
      range.setStartBefore(cells[fromColumn]!.querySelector('.markdown-block-content')!.firstChild!);
      const endSpan = cells[toColumn]!.querySelector('.markdown-block-content')!;
      range.setEnd(endSpan.lastChild!, endSpan.lastChild!.textContent!.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return selection.toString();
    }, { rowIndex: row, fromColumn: from, toColumn: to });
  }

  /** Reopens the document from the library, as a later reading session does. */
  async function reopen(documentId: string): Promise<void> {
    await returnToLibrary(app);
    await app.window.getByTestId(`read-doc-${documentId}`).click();
    await expect(app.window.getByTestId('reader-view')).toBeVisible();
    await expect(app.window.locator('.markdown-table').first()).toBeVisible();
  }

  async function annotationStatuses(documentId: string): Promise<readonly string[]> {
    return app.window.evaluate(async (docId) => {
      const list = await window.interleafAPI.annotations.list(docId);
      return list.map((annotation) => annotation.status);
    }, documentId);
  }

  test('offers every selection action for a later header cell and keeps the highlight after reopen', async () => {
    const documentId = await openFixture();

    const selectedText = await selectCell(null, 1);
    expect(selectedText).toContain('Wins');

    const toolbar = app.window.getByTestId('annotation-selection-toolbar');
    await expect(toolbar).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Yellow highlight' })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Add note' })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Ask AI' })).toBeVisible();

    await toolbar.getByRole('button', { name: 'Yellow highlight' }).click();
    await expect.poll(async () =>
      app.window.evaluate(async (docId) =>
        (await window.interleafAPI.annotations.list(docId)).length,
      documentId)
    ).toBe(1);

    const [saved] = await app.window.evaluate(async (docId) =>
      window.interleafAPI.annotations.list(docId),
    documentId);
    expect(saved!.selectedText).toBe('Wins');
    if (saved!.anchor.format !== 'markdown') throw new Error('Expected a Markdown anchor');
    // The offset is measured over the whole table, so a later cell cannot start
    // at zero; that is exactly what the first-span root could never express.
    expect(saved!.anchor.characterStart).toBeGreaterThan(0);

    await reopen(documentId);
    await expect.poll(async () => annotationStatuses(documentId)).toEqual(['anchored']);
    await expect.poll(async () => app.window.evaluate(() => {
      const customCss = CSS as { highlights?: Map<string, { size: number }> };
      return customCss.highlights?.get('interleaf-yellow')?.size ?? 0;
    })).toBe(1);
  });

  test('saves a note on a body cell with inline formatting and re-anchors it after reopen', async () => {
    const documentId = await openFixture();

    const selectedText = await selectCell(0, 2);
    expect(selectedText).toContain('Streak of six');

    const toolbar = app.window.getByTestId('annotation-selection-toolbar');
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole('button', { name: 'Add note' }).click();
    await app.window.locator('#selection-note').fill('Longest run of the season.');
    await toolbar.getByRole('button', { name: 'Save note' }).click();

    await expect.poll(async () =>
      app.window.evaluate(async (docId) =>
        (await window.interleafAPI.annotations.list(docId)).length,
      documentId)
    ).toBe(1);

    await reopen(documentId);
    const [restored] = await app.window.evaluate(async (docId) =>
      window.interleafAPI.annotations.list(docId),
    documentId);
    expect(restored!.status).toBe('anchored');
    expect(restored!.note).toBe('Longest run of the season.');
    expect(restored!.selectedText).toBe('Streak of six');
  });

  test('anchors a sweep across cells of one row', async () => {
    const documentId = await openFixture();

    const selectedText = await selectAcrossRowCells(0, 0, 1);
    expect(selectedText).toContain('Black Mambas');
    expect(selectedText).toContain('12');

    const toolbar = app.window.getByTestId('annotation-selection-toolbar');
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole('button', { name: 'Green highlight' }).click();

    await expect.poll(async () =>
      app.window.evaluate(async (docId) =>
        (await window.interleafAPI.annotations.list(docId)).length,
      documentId)
    ).toBe(1);

    const [saved] = await app.window.evaluate(async (docId) =>
      window.interleafAPI.annotations.list(docId),
    documentId);
    if (saved!.anchor.format !== 'markdown') throw new Error('Expected a Markdown anchor');
    // The stored quote is the table's own DOM text, which joins the cells
    // without the tab the platform puts in the copied string.
    expect(saved!.anchor.quote.exact).toBe('Black Mambas12');

    await reopen(documentId);
    await expect.poll(async () => annotationStatuses(documentId)).toEqual(['anchored']);
  });

  test('keeps the table region focusable for keyboard scrolling', async () => {
    await openFixture();
    // The wrapper only takes focus when the table actually overflows; either
    // way the selection change must not have altered the region's own role.
    const region = app.window.locator('.markdown-table-wrapper').first();
    await selectCell(null, 1);
    await expect(app.window.getByTestId('annotation-selection-toolbar')).toBeVisible();
    const attributes = await region.evaluate((element) => ({
      tabIndex: element.getAttribute('tabindex'),
      role: element.getAttribute('role'),
    }));
    expect(attributes.tabIndex === null || attributes.tabIndex === '0').toBe(true);
    expect(attributes.role === null || attributes.role === 'region').toBe(true);
  });
});
