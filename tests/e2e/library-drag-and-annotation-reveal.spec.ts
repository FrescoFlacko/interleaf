import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makeMarkdownFixture } from '../fixtures/document-fixtures';

/**
 * The two claims that only a real window can settle.
 *
 * A new annotation must be brought to the top of a scrolled panel, which needs
 * real layout, a real scroll position, and Chromium's own scroll anchoring —
 * none of which jsdom has. And a book must actually move when it is dragged
 * onto a folder, which needs a real HTML5 drag between two real elements.
 *
 * No AI provider is contacted: this exercises the library, the reader, and the
 * annotation store only.
 */

const TALL_NOTE_TARGET = 'the guarantee is easiest to state backwards';
/** Long enough that its row alone overflows the panel's viewport. */
const TALL_NOTE_BODY = Array.from(
  { length: 40 },
  (_unused, index) => `Line ${String(index + 1)}: a lease only bounds divergence while clocks hold.`
).join('\n\n');
const HIGHLIGHT_PHRASE = 'quorum overlap guarantees a shared record';
/** A second short mark, so a row can be deleted with the list still full. */
const SPARE_PHRASE = 'a quorum is a majority set';

/** Selects a phrase through the reader's own selection pathway. */
async function selectPhrase(page: Page, needle: string): Promise<void> {
  await page.evaluate((n) => {
    for (const block of document.querySelectorAll<HTMLElement>('[data-markdown-block]')) {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const index = (node.textContent ?? '').indexOf(n);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + n.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        return;
      }
    }
    throw new Error(`selection target not found: ${n}`);
  }, needle);
}

async function clearSelection(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
  });
}

test.describe('Annotation reveal and library drag-to-folder', () => {
  test.setTimeout(120_000);
  let app: AppHandle;
  let fixtureDir: string;
  let fixturePath: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-drag-reveal-'));
    fixturePath = join(fixtureDir, 'Consistency Notes.md');
    writeFileSync(
      fixturePath,
      makeMarkdownFixture({
        title: 'Consistency Notes',
        author: 'Interleaf E2E',
        body: [
          '# Consistency Notes',
          '',
          `Majority reads and majority writes intersect, so ${HIGHLIGHT_PHRASE} even when a minority is unreachable.`,
          '',
          `Stated plainly, ${SPARE_PHRASE} and nothing about that count changes when a replica returns.`,
          '',
          `For teaching, ${TALL_NOTE_TARGET}, starting from the read and working towards the write.`,
          '',
        ].join('\n'),
      })
    );

    app = await launchInterleaf();
    await expect(app.window.getByTestId('library-view')).toBeVisible();
    await stubOpenDialog(app, [fixturePath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
  });

  test.afterEach(async () => {
    const userDataDir = app.userDataDir;
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('brings a newly created highlight to the top of a scrolled annotations panel', async () => {
    const docs = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    await app.window.getByTestId(`read-doc-${docs[0]!.id}`).click();
    await expect(app.window.getByTestId('markdown-content-wrapper')).toBeVisible();

    // A note tall enough that the panel can be scrolled well past its start.
    const toolbar = app.window.getByTestId('annotation-selection-toolbar');
    await selectPhrase(app.window, TALL_NOTE_TARGET);
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole('button', { name: 'Add note' }).click();
    await app.window.locator('#selection-note').fill(TALL_NOTE_BODY);
    await toolbar.getByRole('button', { name: 'Save note' }).click();
    await expect(toolbar).toBeHidden();
    await clearSelection(app.window);

    await app.window.locator('#companion-tab-annotations').click();
    const list = app.window.getByTestId('annotation-page-list');
    await expect(list).toBeVisible();
    await expect(app.window.getByTestId('annotation-row')).toHaveCount(1);

    // Park the reader mid-way through that note.
    const parked = await list.evaluate((node) => {
      node.scrollTop = Math.floor((node.scrollHeight - node.clientHeight) / 2);
      return node.scrollTop;
    });
    expect(parked).toBeGreaterThan(0);

    await selectPhrase(app.window, HIGHLIGHT_PHRASE);
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole('button', { name: 'Yellow highlight' }).click();
    await expect(toolbar).toBeHidden();
    await clearSelection(app.window);

    await expect(app.window.getByTestId('annotation-row')).toHaveCount(2);

    // The new mark is at the top of the panel's own scroll container, and the
    // panel is at its start rather than left where the reader had parked it.
    await expect
      .poll(async () => list.evaluate((node) => node.scrollTop), { timeout: 5_000 })
      .toBe(0);
    const offsets = await list.evaluate((node) => {
      const first = node.children.item(0);
      return {
        firstRowOffset:
          first === null ? -1 : first.getBoundingClientRect().top - node.getBoundingClientRect().top,
        anchoring: getComputedStyle(node).overflowAnchor,
      };
    });
    expect(Math.abs(offsets.firstRowOffset)).toBeLessThanOrEqual(1);
    // Chromium's scroll anchoring is off for this container, so a row growing
    // above the viewport cannot silently pull the panel back down.
    expect(offsets.anchoring).toBe('none');
  });

  /**
   * The other half of the reveal's promise: having moved the list once, on
   * request, the panel must then leave it alone. Refreshing, editing,
   * deleting and filtering all re-render the list, and a reader who has
   * scrolled somewhere deliberately must still be there afterwards.
   */
  test('leaves the list where the reader put it during ordinary panel activity', async () => {
    const docs = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    await app.window.getByTestId(`read-doc-${docs[0]!.id}`).click();
    await expect(app.window.getByTestId('markdown-content-wrapper')).toBeVisible();
    // Deleting asks for confirmation through a native dialog, which no test
    // can answer; the answer is stubbed so the delete itself can be exercised.
    await app.window.evaluate(() => {
      window.confirm = () => true;
    });

    /** Marks a passage the way the reader does, through the selection toolbar. */
    const toolbar = app.window.getByTestId('annotation-selection-toolbar');
    const highlight = async (phrase: string): Promise<void> => {
      await selectPhrase(app.window, phrase);
      await expect(toolbar).toBeVisible();
      await toolbar.getByRole('button', { name: 'Yellow highlight' }).click();
      await expect(toolbar).toBeHidden();
      await clearSelection(app.window);
    };

    // Newest first, so this order leaves a short highlight as the last row —
    // one that is wholly on screen at the end of the list and can be deleted
    // the way a reader deletes it — with the tall note above it keeping the
    // list overflowing afterwards.
    await highlight(SPARE_PHRASE);
    await selectPhrase(app.window, TALL_NOTE_TARGET);
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole('button', { name: 'Add note' }).click();
    await app.window.locator('#selection-note').fill(TALL_NOTE_BODY);
    await toolbar.getByRole('button', { name: 'Save note' }).click();
    await expect(toolbar).toBeHidden();
    await clearSelection(app.window);
    await highlight(HIGHLIGHT_PHRASE);

    await app.window.locator('#companion-tab-annotations').click();
    const list = app.window.getByTestId('annotation-page-list');
    await expect(app.window.getByTestId('annotation-row')).toHaveCount(3);
    await expect.poll(async () => list.evaluate((node) => node.scrollTop)).toBe(0);

    /** Where the reader has scrolled to, and where they must still be. */
    const park = async (): Promise<number> =>
      list.evaluate((node) => {
        node.scrollTop = 300;
        return node.scrollTop;
      });
    const scrollTop = async (): Promise<number> => list.evaluate((node) => node.scrollTop);
    expect(await park()).toBe(300);

    /**
     * Presses a control the reader has scrolled past.
     *
     * Playwright would bring it into view first, and that scroll is the very
     * thing under test; the app's own click path reaches it without moving the
     * list, which is what leaves the refresh that follows measurable.
     */
    const pressWithoutScrolling = async (name: RegExp | string): Promise<void> => {
      await app.window.getByRole('button', { name }).first().evaluate((node: HTMLElement) => {
        node.click();
      });
    };

    // An edit and the refresh it triggers: recolouring rewrites the row and
    // refetches the page the reveal is no longer waiting on.
    await pressWithoutScrolling(/^Green highlight for /);
    await expect(app.window.getByRole('button', { name: /^Green highlight for / }).first()).toHaveAttribute('aria-pressed', 'true');
    expect(await scrollTop()).toBe(300);

    // A filter round trip. The reader lands back on the same list, and their
    // scroll position survives the refresh that follows it.
    const chips = app.window.getByTestId('annotation-filter-chips');
    await chips.getByRole('button', { name: /^Notes/ }).click();
    await expect(app.window.getByTestId('annotation-row')).toHaveCount(1);
    await chips.getByRole('button', { name: /^All/ }).click();
    await expect(app.window.getByTestId('annotation-row')).toHaveCount(3);
    expect(await park()).toBe(300);

    // A delete, from the end of the list where the row and its menu are the
    // ones actually on screen. The list is shorter afterwards, so the only
    // movement allowed is the browser clamping to the new maximum.
    const atEnd = await list.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      return node.scrollTop;
    });
    expect(atEnd).toBeGreaterThan(0);
    await app.window.getByTestId('annotation-row').last().getByTestId('annotation-row-menu').click();
    await app.window.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(app.window.getByTestId('annotation-row')).toHaveCount(2);
    const settled = await list.evaluate((node) => ({
      scrollTop: node.scrollTop,
      maxScroll: node.scrollHeight - node.clientHeight,
    }));
    // Within a pixel: the reported maximum is rounded to whole pixels while
    // the scroll offset itself is not, so an exact clamp is off by the
    // fraction the two disagree about.
    expect(Math.abs(settled.scrollTop - Math.min(atEnd, settled.maxScroll))).toBeLessThanOrEqual(1);
    expect(settled.scrollTop).toBeGreaterThan(0);
  });

  test('files a book by dragging its card onto a folder, and takes it back out', async () => {
    await app.window.getByTestId('new-folder-button').click();
    await app.window.getByTestId('folder-name-input').fill('Research Papers');
    await app.window.getByTestId('submit-folder-button').click();
    await expect(app.window.getByTestId('folder-tree').getByText('Research Papers')).toBeVisible();

    const docs = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    const doc = docs[0]!;
    const folders = await app.window.evaluate(() => window.interleafAPI.library.listFolders());
    const folder = folders.find((entry) => entry.name === 'Research Papers')!;

    const card = app.window.getByTestId(`document-card-${doc.id}`);
    const target = app.window.getByTestId(`folder-drop-target-${folder.id}`);
    await card.dragTo(target);

    await expect(app.window.getByTestId('success-banner')).toContainText('Document moved.');
    // The row's count is hidden while the pointer rests on it, so step away
    // before reading the folder's own tally.
    await app.window.mouse.move(0, 0);
    await expect(app.window.getByTestId(`folder-count-${folder.id}`)).toHaveText('1');
    const filed = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    expect(filed[0]!.folderId).toBe(folder.id);

    // The drag must not have opened the book on its way into the folder.
    await expect(app.window.getByTestId('library-view')).toBeVisible();
    await expect(app.window.getByTestId('markdown-content-wrapper')).toHaveCount(0);

    // Dropping on the library root takes it out of the folder again.
    await app.window.getByTestId(`document-card-${doc.id}`).dragTo(
      app.window.getByTestId('nav-all-documents')
    );
    await expect(app.window.getByTestId('success-banner')).toContainText(
      'Document removed from folder.'
    );
    const unfiled = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    expect(unfiled[0]!.folderId).toBeNull();
  });
});
