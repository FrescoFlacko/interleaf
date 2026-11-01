import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchInterleaf, returnToLibrary, settleAbandonedLaunches, type AppHandle, type LaunchRecord } from './helpers';
import { closeThenRemoveOwned, settleOwnedRun } from './owned-run-cleanup';
import { makeDocxFixture } from '../fixtures/document-fixtures';
import { chooseListboxValue } from './listbox';

/** Where a DOCX page sits in the viewport, and whether the scroll moved across two frames. */
type DocxPagePosition = { readonly offset: number; readonly room: number; readonly moved: number };

function measureDocxPage(app: AppHandle, page: number): Promise<DocxPagePosition | null> {
  return app.window.evaluate(async (target) => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="docx-scroll-container"]');
    const wrapper = document.querySelector<HTMLElement>(`[data-testid="docx-page-${String(target)}"]`);
    if (scroller === null || wrapper === null) return null;
    const before = scroller.scrollTop;
    await new Promise<void>((resolve) => { requestAnimationFrame(() => { requestAnimationFrame(() => { resolve(); }); }); });
    return {
      offset: wrapper.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
      room: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
      moved: Math.abs(scroller.scrollTop - before),
    };
  }, page);
}

/** At the top of the viewport, or as far down as the scroller goes. */
function atTopOrEnd(position: DocxPagePosition): boolean {
  return Math.abs(position.offset) < 3 || (position.room <= 1 && position.offset >= 0);
}

/**
 * Whether DOCX page `page` has really arrived: at the top of the viewport (or
 * as far as the scroller can go), with the smooth scroll that brought it there
 * no longer moving across two frames. The page-number field and an attached
 * page node both update before that scroll has even begun.
 */
async function docxPageSettledAtTop(app: AppHandle, page: number): Promise<boolean> {
  const position = await measureDocxPage(app, page);
  return position !== null && atTopOrEnd(position) && position.moved < 0.5;
}

function docxScrollTop(app: AppHandle): Promise<number> {
  return app.window.evaluate(() => document.querySelector<HTMLElement>('[data-testid="docx-scroll-container"]')?.scrollTop ?? -1);
}

test.describe('DOCX Reader End-to-End Workflow', () => {
  let app: AppHandle;
  let fixtureDir: string;
  let docxPath: string;
  // Teardown state. `openApp` is the app this case must still close (unset
  // between a restart's close and its relaunch); `launch` is the latest
  // launch's record, which holds its app even if that launch rejected; `owned`
  // is exactly what this case created: its fixture directory and every
  // directory its launches created, recorded before anything can fail.
  let openApp: AppHandle | undefined;
  let launch: LaunchRecord | undefined;
  let owned: string[] = [];
  const onLaunch = (record: LaunchRecord): void => {
    launch = record;
    owned.push(...record.createdPaths);
  };

  async function launchOwned(userDataDir?: string): Promise<void> {
    openApp = undefined;
    app = await launchInterleaf({ ...(userDataDir === undefined ? {} : { userDataDir }), onLaunch });
    openApp = app;
  }

  /** Quits and relaunches on the same profile, as a reader restarting the app. */
  async function restart(): Promise<void> {
    const profile = app.userDataDir;
    await app.close({ preserveUserData: true });
    await launchOwned(profile);
  }

  test.beforeEach(async () => {
    openApp = undefined;
    launch = undefined;
    owned = [];
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-docx-e2e-'));
    owned.push(fixtureDir);
    docxPath = join(fixtureDir, 'Semantic_Research.docx');
    writeFileSync(docxPath, makeDocxFixture({
      title: 'Semantic Research Notes',
      author: 'Interleaf QA',
      bodyText: 'A unique searchable phrase is anchored to this semantic paragraph.',
      includeExternalRelationship: true,
    }));
    await launchOwned();
  });

  // Removes what this case owns only once its app has closed or positively
  // exited, keeps and names it otherwise, and leaves the case's own failure as
  // it was: a passing case fails on cleanup it could not finish.
  test.afterEach(async () => {
    const testInfo = test.info();
    const open = openApp;
    const last = launch;
    const cleanup = await closeThenRemoveOwned({
      close: async () => {
        if (open !== undefined) await open.close();
        else if (last !== undefined) await last.closeProcess();
        else throw new Error('No launch was recorded: there is no app to close and no process to prove exited.');
      },
      hasExited: () => {
        const child = last?.child ?? null;
        return child !== null && (child.exitCode !== null || child.signalCode !== null);
      },
      owned: [...new Set(owned)],
      remove: (path) => { rmSync(path, { recursive: true, force: true }); },
    });
    const outcomes = [cleanup, ...await settleAbandonedLaunches({ testId: testInfo.testId })];
    testInfo.annotations.push({ type: 'owned-cleanup', description: outcomes.map((outcome) => settleOwnedRun.describe(outcome)).join(' | ') });
    if (testInfo.status !== testInfo.expectedStatus) return;
    for (const outcome of outcomes) settleOwnedRun({ failed: false }, outcome);
  });

  test('imports, renders, navigates, styles, and restores a semantic DOCX anchor', async () => {
    await stubOpenDialog(app, [docxPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const [document] = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    expect(document?.format).toBe('docx');
    expect(document?.title).toBe('Semantic Research Notes');
    await app.window.evaluate(async (documentId) => {
      await window.interleafAPI.library.updateReadingPosition(
        documentId,
        {
          format: 'docx',
          paragraphIndex: 1,
          characterStart: 9,
          characterEnd: 19,
          renderedPageIndex: 0,
        },
        0.1
      );
    }, document!.id);
    await app.window.getByTestId(`read-doc-${document!.id}`).click();

    await expect(app.window.getByTestId('reader-view')).toBeVisible();
    // The header no longer carries a format badge; the rendered DOCX
    // structure below is the evidence that the format was routed correctly.
    await expect(app.window.getByRole('heading', { level: 1, name: 'DOCX Foundations' })).toBeVisible();
    await expect(app.window.getByText('A unique searchable phrase')).toBeVisible();
    await expect(app.window.locator('.docx-table')).toContainText('Term');
    await expect(app.window.locator('.docx-table')).toContainText('Definition');
    await expect(app.window.locator('.docx-page-wrapper img')).toHaveAttribute('src', /^data:image\/png;base64,/);
    expect(await app.window.locator('.docx-viewer-scroll-container').innerHTML()).not.toContain('attacker.invalid');
    await expect.poll(async () => {
      const [saved] = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
      const location = saved?.readingPosition?.location;
      return location?.format === 'docx'
        ? [location.paragraphIndex, location.characterStart, location.characterEnd]
        : [];
    }).toEqual([1, 9, 19]);

    await app.window.getByTestId('toggle-toc-button').click();
    const outline = app.window.getByTestId('reader-outline-sidebar');
    await expect(outline.getByText('Second Section')).toBeVisible();
    await outline.getByText('Second Section').click();
    await expect(app.window.getByTestId('page-number-input')).toHaveValue('2');
    await expect(app.window.getByRole('heading', { level: 2, name: 'Second Section' })).toBeVisible();

    // Defect 24: display controls live in the settings dialog, not inline.
    await app.window.getByTestId('document-settings-button').click();
    await expect(app.window.getByTestId('document-settings-popover')).toBeVisible();
    await chooseListboxValue(app.window.getByTestId('zoom-mode-select'), '1.25');
    await chooseListboxValue(app.window.getByTestId('line-spacing-select'), '1.9');
    await chooseListboxValue(app.window.getByTestId('reader-margin-select'), '4');
    await app.window.keyboard.press('Escape');
    await expect(app.window.getByTestId('document-settings-popover')).toBeHidden();
    const layout = await app.window.getByTestId('docx-page-2').evaluate((page) => ({
      fontSize: Number.parseFloat(getComputedStyle(page).fontSize),
      lineHeight: Number.parseFloat(getComputedStyle(page).lineHeight),
      paddingLeft: Number.parseFloat(getComputedStyle(page).paddingLeft),
    }));
    expect(layout.fontSize).toBeGreaterThan(16);
    expect(layout.lineHeight).toBeGreaterThan(25);
    expect(layout.paddingLeft).toBeGreaterThan(50);

    await expect.poll(async () => {
      const [saved] = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
      const location = saved?.readingPosition?.location;
      return location?.format === 'docx' ? location.paragraphIndex : -1;
    }).toBeGreaterThan(0);

    await returnToLibrary(app);
    await app.window.getByTestId(`read-doc-${document!.id}`).click();
    await expect(app.window.getByTestId('page-number-input')).toHaveValue('2');
    await expect(app.window.getByRole('heading', { level: 2, name: 'Second Section' })).toBeVisible();
  });

  test('creates, paints, edits, and restores annotations across restart', async () => {
    await stubOpenDialog(app, [docxPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [document] = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    await app.window.getByTestId(`read-doc-${document!.id}`).click();
    await expect(app.window.getByText('A unique searchable phrase')).toBeVisible();

    await app.window.locator('[data-docx-paragraph="1"] .docx-paragraph-content').evaluate((content) => {
      const target = 'unique searchable phrase';
      const walker = content.ownerDocument.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const start = node.textContent?.indexOf(target) ?? -1;
        if (start < 0) continue;
        const range = content.ownerDocument.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + target.length);
        const selection = content.ownerDocument.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        content.ownerDocument.dispatchEvent(new Event('selectionchange'));
        return;
      }
      throw new Error('Selection target was not found.');
    });

    const selectionToolbar = app.window.getByTestId('annotation-selection-toolbar');
    await expect(selectionToolbar).toBeVisible();
    await selectionToolbar.getByRole('button', { name: 'Blue highlight' }).click();
    // A highlight is saved in place; the reader opens Annotations to see it.
    await expect(selectionToolbar).toBeHidden();
    await app.window.getByRole('tab', { name: 'Annotations' }).click();
    await expect(app.window.getByRole('tabpanel', { name: 'Annotations' })).toBeVisible();
    await expect(app.window.getByText('“unique searchable phrase”')).toBeVisible();
    await expect.poll(async () => app.window.evaluate(() => {
      const highlights = (CSS as { highlights?: { has(name: string): boolean } }).highlights;
      return highlights?.has('interleaf-blue') ?? false;
    })).toBe(true);

    await app.window.getByTestId('annotation-page-list').getByRole('button', { name: 'Add note' }).click();
    await app.window.getByLabel('Note text').fill('Connect this to the research summary.');
    await app.window.getByRole('button', { name: /^Done/u }).click();
    await expect(app.window.getByText('Connect this to the research summary.')).toBeVisible();
    await app.window.getByTestId('add-bookmark-button').click();
    await expect(app.window.getByTestId('annotation-page-list').getByText('Bookmark', { exact: true })).toBeVisible();

    await expect.poll(async () => app.window.evaluate(async (documentId) =>
      (await window.interleafAPI.annotations.list(documentId, { limit: 100 })).length,
    document!.id)).toBe(2);

    await restart();
    const [restoredDocument] = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    await app.window.getByTestId(`read-doc-${restoredDocument!.id}`).click();
    await expect(app.window.getByText('A unique searchable phrase')).toBeVisible();
    await app.window.getByRole('tab', { name: 'Annotations' }).click();
    await expect(app.window.getByText('“unique searchable phrase”')).toBeVisible();
    await expect(app.window.getByText('Connect this to the research summary.')).toBeVisible();
    await expect(app.window.getByTestId('annotation-page-list').getByText('Bookmark', { exact: true })).toBeVisible();
    await expect.poll(async () => app.window.evaluate(() => {
      const highlights = (CSS as { highlights?: { has(name: string): boolean } }).highlights;
      return highlights?.has('interleaf-blue') ?? false;
    })).toBe(true);
  });

  test('indexes DOCX text, jumps from search provenance, and persists a note across restart', async () => {
    await stubOpenDialog(app, [docxPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [document] = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    await app.window.getByTestId(`read-doc-${document!.id}`).click();
    await expect(app.window.getByText('A unique searchable phrase')).toBeVisible();

    await expect.poll(async () => app.window.evaluate(async (documentId) =>
      (await window.interleafAPI.search.getIndexState(documentId))?.status,
    document!.id)).toBe('ready');
    await app.window.getByRole('tab', { name: 'Search' }).click();
    await app.window.getByLabel('Search indexed text').fill('unique searchable phrase');
    await app.window.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(app.window.getByText(/unique searchable phrase/i).last()).toBeVisible();
    const provenance = app.window.getByRole('button', {
      name: /Jump to Rendered page 1 in Semantic Research Notes/i,
    });
    await provenance.click();
    await expect(app.window.getByTestId('page-number-input')).toHaveValue('1');

    await app.window.getByTestId('reader-header-toolbar').getByRole('button', { name: 'Add note' }).click();
    await app.window.getByRole('textbox', { name: 'Note at current location' }).fill('Search provenance note survives restart.');
    await app.window.getByRole('button', { name: /^Done/u }).click();
    await expect(app.window.locator('#location-note-popover')).toBeHidden();
    await expect(app.window.getByText('Search provenance note survives restart.')).toBeVisible();
    const [savedNote] = await app.window.evaluate(async (documentId) =>
      window.interleafAPI.annotations.list(documentId, { type: 'note', limit: 50 }),
    document!.id);
    expect(savedNote).toMatchObject({ status: 'anchored', anchor: { format: 'docx', paragraphIndex: 1 } });

    await app.window.getByTestId('page-number-input').fill('2');
    await app.window.getByTestId('page-number-input').press('Enter');
    await expect(app.window.getByTestId('page-number-input')).toHaveValue('2');

    await restart();
    const [restored] = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    await app.window.getByTestId(`read-doc-${restored!.id}`).click();
    await expect(app.window.getByText('A unique searchable phrase')).toBeVisible();
    await app.window.getByRole('tab', { name: 'Annotations' }).click();
    const restoredNoteText = app.window.getByText('Search provenance note survives restart.');
    await expect(restoredNoteText).toBeVisible();
    const restoredCard = restoredNoteText.locator('xpath=ancestor::li');
    // A resolved anchor is stated by the row carrying no lost-anchor warning
    // and still offering the jump — the redesigned panel spends chrome only on
    // the state that needs the reader's attention.
    await expect(restoredCard).toHaveAttribute('data-annotation-status', 'anchored');
    await expect(restoredCard.getByTestId('annotation-unanchored-warning')).toHaveCount(0);
    await restoredCard.getByRole('button', { name: 'Jump' }).click();
    await expect(app.window.getByTestId('page-number-input')).toHaveValue('1');
    await expect.poll(async () => app.window.locator('[data-docx-paragraph="1"]').evaluate((paragraph) => {
      const rect = paragraph.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight;
    })).toBe(true);
  });

  test('terminates an active production DOCX parser worker when the reader closes', async () => {
    const stressPath = join(fixtureDir, 'DOCX_Cancellation_Stress.docx');
    writeFileSync(stressPath, makeDocxFixture({
      title: 'DOCX Cancellation Stress',
      includeImage: false,
      extraParagraphs: 30_000,
    }));
    await stubOpenDialog(app, [stressPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [document] = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    await app.window.getByTestId(`read-doc-${document!.id}`).click();
    await expect(app.window.getByTestId('reader-view')).toBeVisible();
    await expect(app.window.getByTestId('reader-loading')).toBeVisible();
    await returnToLibrary(app);
    await expect(app.window.getByTestId('library-view')).toBeVisible();
    await expect(app.window.getByTestId('reader-view')).not.toBeVisible();

    await stubOpenDialog(app, [docxPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect.poll(async () => {
      const documents = await app.window.evaluate(async () =>
        window.interleafAPI.library.listDocuments()
      );
      return documents.find((candidate) => candidate.title === 'Semantic Research Notes')?.id ?? '';
    }).not.toBe('');
    const documents = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    const recoveryDocument = documents.find((candidate) => candidate.title === 'Semantic Research Notes');
    await app.window.getByTestId(`read-doc-${recoveryDocument!.id}`).click();
    await expect(app.window.getByRole('heading', { level: 1, name: 'DOCX Foundations' })).toBeVisible();
    await expect(app.window.getByText('A unique searchable phrase')).toBeVisible();
  });

  /** Imports and opens a DOCX long enough to virtualize its pages. */
  async function openVirtualizationStress(): Promise<void> {
    const longPath = join(fixtureDir, 'DOCX_Virtualization_Stress.docx');
    writeFileSync(longPath, makeDocxFixture({
      title: 'DOCX Virtualization Stress',
      includeImage: false,
      extraParagraphs: 920,
    }));
    await stubOpenDialog(app, [longPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const documents = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    const document = documents.find((candidate) => candidate.title === 'DOCX Virtualization Stress');
    expect(document).toBeDefined();
    await app.window.getByTestId(`read-doc-${document!.id}`).click();
    await expect(app.window.getByRole('heading', { level: 1, name: 'DOCX Foundations' })).toBeVisible();
  }

  test('keeps production DOCX page content bounded while jumping through a long document', async () => {
    await openVirtualizationStress();
    const pageCount = await app.window.locator('.docx-page-wrapper').count();
    expect(pageCount).toBeGreaterThan(20);

    for (const page of [5, 10, 15, 20, pageCount]) {
      const input = app.window.getByTestId('page-number-input');
      await input.fill(String(page));
      await input.press('Enter');
      await expect(input).toHaveValue(String(page));
      await expect(app.window.getByTestId(`docx-page-${String(page)}`).locator('[data-docx-paragraph]').first()).toBeAttached();
      await expect.poll(async () => app.window.locator('.docx-page-wrapper').evaluateAll((wrappers) =>
        wrappers.filter((wrapper) => wrapper.childElementCount > 0).length
      )).toBeLessThanOrEqual(7);
      // The next jump starts from this page, not from somewhere on the way to it.
      await expect.poll(() => docxPageSettledAtTop(app, page)).toBe(true);
      // Settled there, the reader still reports that page, not the one before it.
      await expect(input).toHaveValue(String(page));
    }
  });

  test('keeps a page number typed while the previous jump is still scrolling, and goes to that page', async () => {
    await openVirtualizationStress();
    const input = app.window.getByTestId('page-number-input');
    await input.fill('5');
    await input.press('Enter');
    // Type the next page while the smooth scroll to page 5 is still under way:
    // it reports every page it passes, and none of them may replace the draft.
    await input.fill('10');
    const scrollTopWhenTyped = await docxScrollTop(app);
    await expect.poll(() => docxPageSettledAtTop(app, 5)).toBe(true);
    // The scroll really was still moving after the page was typed.
    expect(await docxScrollTop(app)).not.toBe(scrollTopWhenTyped);
    await expect(input).toHaveValue('10');
    await input.press('Enter');
    await expect(input).toHaveValue('10');
    await expect.poll(() => docxPageSettledAtTop(app, 10)).toBe(true);
    await expect(input).toHaveValue('10');
  });

  test('derives and restores an exact range inside a long wrapped paragraph', async () => {
    const wrappedBody = Array.from({ length: 6_000 }, (_, index) =>
      `wrapped-anchor-${String(index)}`
    ).join(' ');
    const wrappedPath = join(fixtureDir, 'DOCX_Wrapped_Anchor.docx');
    writeFileSync(wrappedPath, makeDocxFixture({
      title: 'DOCX Wrapped Anchor',
      bodyText: wrappedBody,
      includeImage: false,
    }));
    await stubOpenDialog(app, [wrappedPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const documents = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    const document = documents.find((candidate) => candidate.title === 'DOCX Wrapped Anchor');
    expect(document).toBeDefined();
    await app.window.getByTestId(`read-doc-${document!.id}`).click();
    await expect(app.window.getByRole('heading', { level: 1, name: 'DOCX Foundations' })).toBeVisible();

    await app.window.getByTestId('docx-scroll-container').evaluate((scroller) => {
      const paragraph = scroller.querySelector<HTMLElement>('[data-docx-paragraph="1"]');
      if (!paragraph) throw new Error('Wrapped paragraph did not render.');
      const scrollerRect = scroller.getBoundingClientRect();
      const paragraphRect = paragraph.getBoundingClientRect();
      scroller.scrollTop += paragraphRect.top + paragraphRect.height * 0.7
        - (scrollerRect.top + scroller.clientHeight / 3);
      scroller.dispatchEvent(new Event('scroll'));
    });

    await expect.poll(async () => {
      const savedDocuments = await app.window.evaluate(async () =>
        window.interleafAPI.library.listDocuments()
      );
      const saved = savedDocuments.find((candidate) => candidate.id === document!.id);
      const location = saved?.readingPosition?.location;
      if (location?.format !== 'docx') return null;
      return {
        paragraphIndex: location.paragraphIndex,
        characterStart: location.characterStart ?? -1,
        characterEnd: location.characterEnd ?? -1,
      };
    }).toMatchObject({ paragraphIndex: 1 });

    const persisted = await app.window.evaluate(async (documentId) => {
      const savedDocuments = await window.interleafAPI.library.listDocuments();
      const location = savedDocuments.find((candidate) => candidate.id === documentId)?.readingPosition?.location;
      return location?.format === 'docx' ? location : null;
    }, document!.id);
    expect(persisted?.characterStart).toBeGreaterThan(wrappedBody.length / 2);
    expect(persisted?.characterEnd).toBe((persisted?.characterStart ?? -1) + 1);

    await returnToLibrary(app);
    await app.window.getByTestId(`read-doc-${document!.id}`).click();
    await expect(app.window.getByRole('heading', { level: 1, name: 'DOCX Foundations' })).toBeAttached();
    const restored = await app.window.getByTestId('docx-scroll-container').evaluate((scroller) => {
      const content = scroller.querySelector<HTMLElement>('[data-docx-paragraph="1"] .docx-paragraph-content');
      if (!content) throw new Error('Wrapped paragraph did not restore.');
      const scrollerRect = scroller.getBoundingClientRect();
      const contentRect = content.getBoundingClientRect();
      const ownerDocument = content.ownerDocument;
      const position = ownerDocument.caretPositionFromPoint(contentRect.left + 8, scrollerRect.top + 24);
      let offset = -1;
      if (position?.offsetNode && content.contains(position.offsetNode)) {
        const prefix = ownerDocument.createRange();
        prefix.selectNodeContents(content);
        prefix.setEnd(position.offsetNode, position.offset);
        offset = prefix.toString().length;
      }
      return { scrollTop: scroller.scrollTop, offset };
    });
    expect(restored.scrollTop).toBeGreaterThan(1_000);
    expect(Math.abs(restored.offset - (persisted?.characterStart ?? -1))).toBeLessThan(200);
  });
});

async function stubOpenDialog(app: AppHandle, filePaths: readonly string[]): Promise<void> {
  await app.electronApp.evaluate(({ dialog }, selectedPaths) => {
    dialog.showOpenDialog = () =>
      Promise.resolve({ canceled: false, filePaths: [...selectedPaths], bookmarks: [] });
  }, filePaths);
}
