import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import { makeMarkdownFixture } from '../fixtures/document-fixtures';

/**
 * Visual evidence for the Annotations tab in a real BrowserWindow, against the
 * reference design's `#4a` section.
 *
 * The renderer suite already pins the structure; what a screenshot adds is the
 * part that only shows up once real type, real spacing and a real highlight
 * color are painted together. The assertions here are the ones a picture cannot
 * make on its own: the note's own words lead each entry, the quoted passage is
 * demoted behind them, a highlight's rail and quote carry the marker color the
 * reader actually chose, and no entry wears an "Anchored" badge — only the
 * entries that lost their place say anything about their status at all.
 *
 * No AI provider is contacted: this exercises the reader and the annotation
 * store only.
 */

const VISUAL_DIR = process.env.INTERLEAF_VISUAL_DIR ?? join(process.cwd(), 'agent', 'visual');
const HIGHLIGHT_PHRASE = 'quorum overlap guarantees a shared record';
const NOTE_PHRASE = 'leases bound the window of divergence';
const NOTE_BODY = 'A lease only bounds divergence while clocks stay within the assumed drift.';

/** Two comparable short marks: one highlight, one note, each a single line. */
const SHORT_HIGHLIGHT = 'a quorum is a majority set';
const SHORT_NOTE_TARGET = 'a lease is a bounded promise';
const SHORT_NOTE_BODY = 'Bounded promise, bounded risk.';

/** A passage far longer than one line, highlighted without a note. */
const LONG_HIGHLIGHT =
  'the operator who has to answer for an outage wants the guarantee stated as a rule they can apply ' +
  'at three in the morning, not as a proof they have to reconstruct from the paper before they can ' +
  'decide whether the cluster is safe to restart';

/** A note whose saved source is Markdown, rendered into several blocks. */
const LONG_NOTE_TARGET = 'the guarantee is easiest to state backwards';
const LONG_NOTE_BODY = [
  '**Read this backwards.**',
  '',
  '1. A write is durable once a majority has it.',
  '2. A read that touches a majority touches that write.',
  '3. Therefore a read cannot miss a completed write.',
  '',
  'The assumption doing the work is the clock bound; without it the lease says nothing and',
  'the third step is only true of writes that finished before the partition began.',
].join('\n');

/** The last words of the long note, used to prove nothing was cut off. */
const LONG_NOTE_TAIL = 'before the partition began.';

/**
 * One row's real painted geometry. Only Chromium can answer these: jsdom has no
 * layout, so equal-height and overflow claims cannot be made there at all.
 */
function measureRow(row: HTMLElement): {
  readonly height: number;
  readonly paddingTop: number;
  readonly paddingBottom: number;
  readonly paddingLeft: number;
  readonly metaTop: number;
  readonly actionsTop: number;
  readonly actionsBottom: number;
  readonly primaryTop: number;
  readonly primaryBottom: number;
  readonly primaryOverflowX: number;
  readonly primaryClipped: number;
  readonly clipped: number;
} {
  const box = row.getBoundingClientRect();
  const style = getComputedStyle(row);
  // The whole measurement is serialized into the page, so every helper it uses
  // has to travel with it rather than live at module scope.
  const node = (selector: string): HTMLElement | null => row.querySelector<HTMLElement>(selector);
  const of = (element: HTMLElement | null, absent: number, value: (element: HTMLElement) => number): number =>
    element === null ? absent : value(element);
  const primary = node('[data-testid="annotation-note-body"]') ?? node('[data-testid="annotation-quote"]');
  const actions = node('[data-testid="annotation-row-actions"]');
  const meta = node('[data-testid="annotation-meta-type"]');
  const innerRight = box.right - Number.parseFloat(style.paddingRight);
  return {
    height: box.height,
    paddingTop: Number.parseFloat(style.paddingTop),
    paddingBottom: Number.parseFloat(style.paddingBottom),
    paddingLeft: Number.parseFloat(style.paddingLeft),
    metaTop: of(meta, -1, (it) => it.getBoundingClientRect().top - box.top),
    actionsTop: of(actions, -1, (it) => it.getBoundingClientRect().top - box.top),
    actionsBottom: of(actions, -1, (it) => box.bottom - it.getBoundingClientRect().bottom),
    primaryTop: of(primary, -1, (it) => it.getBoundingClientRect().top - box.top),
    primaryBottom: of(primary, -1, (it) => it.getBoundingClientRect().bottom - box.top),
    primaryOverflowX: of(primary, 0, (it) => Math.max(0, it.getBoundingClientRect().right - innerRight)),
    primaryClipped: of(primary, 0, (it) => it.scrollHeight - it.clientHeight),
    clipped: row.scrollHeight - row.clientHeight,
  };
}

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

/** Drops the live selection so its paint never sits over an annotation's. */
async function clearSelection(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
  });
}

test.describe('Annotations panel 4a redesign', () => {
  test.setTimeout(120_000);
  let app: AppHandle;
  let fixtureDir: string;
  let fixturePath: string;

  test.beforeAll(() => {
    mkdirSync(VISUAL_DIR, { recursive: true });
  });

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-annotations-4a-'));
    fixturePath = join(fixtureDir, 'Consistency Notes.md');
    writeFileSync(
      fixturePath,
      makeMarkdownFixture({
        title: 'Consistency Notes',
        author: 'Interleaf Visual Evidence',
        body: [
          '# Consistency Notes',
          '',
          `Majority reads and majority writes intersect, so ${HIGHLIGHT_PHRASE} even when a minority is unreachable.`,
          '',
          `Under a bounded clock assumption, ${NOTE_PHRASE} to the lease term rather than to the network.`,
          '',
          `Stated plainly, ${SHORT_HIGHLIGHT} and nothing about that count changes when a replica returns.`,
          '',
          `Stated again, ${SHORT_NOTE_TARGET} and it expires whether or not anybody was listening.`,
          '',
          `In an incident review, ${LONG_HIGHLIGHT}.`,
          '',
          `For teaching, ${LONG_NOTE_TARGET}, starting from the read and working towards the write.`,
          '',
        ].join('\n'),
      })
    );

    app = await launchInterleaf();
    await expect(app.window.getByTestId('library-view')).toBeVisible();
    await stubOpenDialog(app, [fixturePath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const docs = await app.window.evaluate(() => window.interleafAPI.library.listDocuments());
    await app.window.getByTestId(`read-doc-${docs[0]!.id}`).click();
    await expect(app.window.getByTestId('markdown-content-wrapper')).toBeVisible();
  });

  test.afterEach(async () => {
    const userDataDir = app.userDataDir;
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  /** Marks a passage through the reader's own selection toolbar. */
  async function addHighlight(phrase: string): Promise<void> {
    const toolbar = app.window.getByTestId('annotation-selection-toolbar');
    await selectPhrase(app.window, phrase);
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole('button', { name: 'Yellow highlight' }).click();
    await expect(toolbar).toBeHidden();
    await clearSelection(app.window);
  }

  /** Writes a note against a passage, saving the body verbatim. */
  async function addNote(phrase: string, body: string): Promise<void> {
    const toolbar = app.window.getByTestId('annotation-selection-toolbar');
    await selectPhrase(app.window, phrase);
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole('button', { name: 'Add note' }).click();
    await app.window.locator('#selection-note').fill(body);
    await toolbar.getByRole('button', { name: /^Done/u }).click();
    await expect(toolbar).toBeHidden();
    await clearSelection(app.window);
  }

  /** Opens the Annotations tab and waits for its rows. */
  async function openAnnotations(expectedRows: number): Promise<Locator> {
    await app.window.locator('#companion-tab-annotations').click();
    const browser = app.window.getByTestId('annotation-browser');
    await expect(browser).toBeVisible();
    await expect(browser.getByTestId('annotation-row')).toHaveCount(expectedRows);
    return browser;
  }

  test('gives a short note and a short highlight the same row geometry', async () => {
    await addHighlight(SHORT_HIGHLIGHT);
    await addNote(SHORT_NOTE_TARGET, SHORT_NOTE_BODY);
    const browser = await openAnnotations(2);

    const noteRow = browser.getByTestId('annotation-row').filter({ hasText: SHORT_NOTE_BODY });
    const highlightRow = browser.getByTestId('annotation-row').filter({ hasText: SHORT_HIGHLIGHT });
    await expect(noteRow).toHaveCount(1);
    await expect(highlightRow).toHaveCount(1);

    const note = await noteRow.evaluate(measureRow);
    const highlight = await highlightRow.evaluate(measureRow);

    // The claim the reference makes: two kinds of mark, one object. A short note
    // and a comparably short highlight are the same size, sit on the same
    // padding, and put their metadata and their controls on the same lines.
    expect(highlight.height).toBeCloseTo(note.height, 1);
    expect(highlight.paddingTop).toBeCloseTo(note.paddingTop, 1);
    expect(highlight.paddingBottom).toBeCloseTo(note.paddingBottom, 1);
    expect(highlight.paddingLeft).toBeCloseTo(note.paddingLeft, 1);
    expect(highlight.metaTop).toBeCloseTo(note.metaTop, 1);
    expect(highlight.primaryTop).toBeCloseTo(note.primaryTop, 1);
    expect(highlight.actionsBottom).toBeCloseTo(note.actionsBottom, 1);

    // Neither row hides any of its own content to reach that size, and the
    // controls never ride up over the text.
    for (const row of [note, highlight]) {
      expect(row.clipped).toBeLessThanOrEqual(0);
      expect(row.primaryClipped).toBeLessThanOrEqual(0);
      expect(row.primaryOverflowX).toBeLessThanOrEqual(0.5);
      expect(row.primaryBottom).toBeLessThanOrEqual(row.actionsTop + 0.5);
    }

    await browser.screenshot({ path: join(VISUAL_DIR, 'annotations-4a-short-rows.png') });
  });

  test('grows a long note until all of its rendered Markdown is readable', async () => {
    await addHighlight(SHORT_HIGHLIGHT);
    await addHighlight(LONG_HIGHLIGHT);
    await addNote(LONG_NOTE_TARGET, LONG_NOTE_BODY);
    const browser = await openAnnotations(3);

    const shortRow = browser.getByTestId('annotation-row').filter({ hasText: SHORT_HIGHLIGHT });
    const longNoteRow = browser.getByTestId('annotation-row').filter({ hasText: LONG_NOTE_TAIL });
    const longHighlightRow = browser.getByTestId('annotation-row').filter({ hasText: LONG_HIGHLIGHT });

    // The note is stored as its Markdown source and painted as blocks, so the
    // reader sees the answer they saved rather than its syntax.
    const noteBody = longNoteRow.getByTestId('annotation-note-body');
    await expect(noteBody.locator('strong')).toHaveText('Read this backwards.');
    await expect(noteBody.locator('li')).toHaveCount(3);
    await expect(noteBody).toContainText(LONG_NOTE_TAIL);
    await expect(noteBody).not.toContainText('**');

    const short = await shortRow.evaluate(measureRow);
    const longNote = await longNoteRow.evaluate(measureRow);
    const longHighlight = await longHighlightRow.evaluate(measureRow);

    // The shared floor is a minimum, not a ceiling: the row grew to fit every
    // block, and nothing inside it is scrolled out of sight or clamped away.
    expect(longNote.height).toBeGreaterThan(short.height + 40);
    expect(longNote.clipped).toBeLessThanOrEqual(0);
    expect(longNote.primaryClipped).toBeLessThanOrEqual(0);
    expect(longNote.primaryBottom).toBeLessThanOrEqual(longNote.actionsTop + 0.5);

    // Every rendered block really is inside the row that is supposed to hold
    // it, including the last one, which is the one a clamp would take first.
    const tailFits = await longNoteRow.evaluate((row, tail) => {
      const box = row.getBoundingClientRect();
      const blocks = [...row.querySelectorAll<HTMLElement>('[data-testid="markdown-content"] > *')];
      const holder = blocks.filter((block) => block.textContent.includes(tail)).at(-1);
      const last = blocks.at(-1)?.getBoundingClientRect();
      return {
        blocks: blocks.length,
        lastBottomInside: last === undefined ? -1 : box.bottom - last.bottom,
        tailBottomInside: holder === undefined ? -1 : box.bottom - holder.getBoundingClientRect().bottom,
        outside: blocks.filter((block) => block.getBoundingClientRect().bottom > box.bottom + 0.5).length,
      };
    }, LONG_NOTE_TAIL);
    expect(tailFits.blocks).toBeGreaterThanOrEqual(3);
    expect(tailFits.lastBottomInside).toBeGreaterThanOrEqual(0);
    expect(tailFits.tailBottomInside).toBeGreaterThanOrEqual(0);
    expect(tailFits.outside).toBe(0);

    // A long highlighted passage stays readable in the same way: it wraps
    // inside the column instead of overflowing it, and it never lands on the
    // metadata line or the controls.
    expect(longHighlight.height).toBeGreaterThan(short.height);
    expect(longHighlight.clipped).toBeLessThanOrEqual(0);
    expect(longHighlight.primaryOverflowX).toBeLessThanOrEqual(0.5);
    expect(longHighlight.primaryTop).toBeGreaterThanOrEqual(longHighlight.metaTop);
    expect(longHighlight.primaryBottom).toBeLessThanOrEqual(longHighlight.actionsTop + 0.5);

    await browser.screenshot({ path: join(VISUAL_DIR, 'annotations-4a-long-note.png') });
  });

  test('lists a highlight and a note in the redesigned layout', async () => {
    const toolbar = app.window.getByTestId('annotation-selection-toolbar');

    await selectPhrase(app.window, HIGHLIGHT_PHRASE);
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole('button', { name: 'Yellow highlight' }).click();
    await expect(toolbar).toBeHidden();
    await clearSelection(app.window);

    await selectPhrase(app.window, NOTE_PHRASE);
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole('button', { name: 'Add note' }).click();
    await app.window.locator('#selection-note').fill(NOTE_BODY);
    await toolbar.getByRole('button', { name: /^Done/u }).click();
    await expect(toolbar).toBeHidden();
    await clearSelection(app.window);

    await app.window.locator('#companion-tab-annotations').click();
    const browser = app.window.getByTestId('annotation-browser');
    await expect(browser).toBeVisible();
    await expect(browser.getByTestId('annotation-row')).toHaveCount(2);

    // Heading, count and document label, search, and a single row of filter
    // chips: the panel's own furniture, before any entry.
    await expect(browser.getByRole('heading', { name: 'Annotations' })).toBeVisible();
    await expect(browser.getByTestId('annotation-count-label')).toContainText('2 in this document');
    await expect(browser.getByPlaceholder('Quote, note, label…')).toBeVisible();
    const chips = browser.getByTestId('annotation-filter-chips');
    for (const label of ['All', 'Highlights', 'Notes']) {
      await expect(chips.getByRole('button', { name: new RegExp(`^${label}`) })).toBeVisible();
    }
    await expect(browser.getByRole('combobox', { name: 'Sort annotations' })).toHaveAttribute('data-value', 'updated_desc');

    // Nothing announces that an annotation is where it was left: that is the
    // ordinary case, and a badge for it was noise on every single row.
    await expect(browser.getByText('Anchored', { exact: false })).toHaveCount(0);
    await expect(browser.getByTestId('annotation-unanchored-warning')).toHaveCount(0);

    const noteRow = browser.getByTestId('annotation-row').filter({ hasText: NOTE_BODY });
    await expect(noteRow.getByTestId('annotation-note-body')).toHaveText(NOTE_BODY);
    // The note leads and the passage it came from follows it.
    const noteOrder = await noteRow.evaluate((row) => {
      const body = row.querySelector('[data-testid="annotation-note-body"]');
      const quote = row.querySelector('[data-testid="annotation-quote"]');
      if (!body || !quote) return 'missing';
      return (body.compareDocumentPosition(quote) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        ? 'note-first'
        : 'quote-first';
    });
    expect(noteOrder).toBe('note-first');
    await expect(noteRow.getByTestId('annotation-quote')).toContainText(NOTE_PHRASE);
    await expect(noteRow.getByRole('button', { name: 'Jump' })).toBeVisible();

    const highlightRow = browser.getByTestId('annotation-row').filter({ hasText: HIGHLIGHT_PHRASE });
    // The highlight carries the marker color the reader chose, on its edge rail
    // and on the quote itself, rather than a uniform accent.
    const highlightColors = await highlightRow.evaluate((row) => {
      const rail = row.querySelector('[data-testid="annotation-rail"]');
      const marker = row.querySelector('[data-testid="annotation-quote-marker"]');
      return {
        rail: rail ? getComputedStyle(rail).backgroundColor : 'missing',
        marker: marker ? getComputedStyle(marker).backgroundColor : 'missing',
      };
    });
    expect(highlightColors.rail).not.toBe('missing');
    expect(highlightColors.rail).not.toBe('rgba(0, 0, 0, 0)');
    expect(highlightColors.marker).not.toBe('missing');
    expect(highlightColors.marker).not.toBe('rgba(0, 0, 0, 0)');
    // A highlight with no note offers to gain one instead of offering to edit nothing.
    await expect(highlightRow.getByRole('button', { name: 'Add note' })).toBeVisible();
    await expect(
      highlightRow.getByRole('button', { name: /^Yellow highlight for / })
    ).toHaveAttribute('aria-pressed', 'true');

    // Compact metadata rather than a sentence per row.
    const metaType = highlightRow.getByTestId('annotation-meta-type');
    await expect(metaType).toBeVisible();
    expect((await metaType.textContent())?.trim()).toBe('Highlight');
    // Plain words, as everywhere else: the type reads "Highlight", not an
    // uppercase code.
    const metaCase = await metaType.evaluate((element) => getComputedStyle(element).textTransform);
    expect(metaCase).toBe('none');
    await expect(highlightRow.getByTestId('annotation-meta-location')).toBeVisible();

    // WCAG 2.2 SC 2.5.8: each colour swatch must be at least 24x24 CSS px, and
    // neighbouring targets at least 24px apart centre to centre. axe does not
    // evaluate target size, and jsdom has no layout, so this is measured here
    // on the painted control. The swatch a reader sees stays 13px — the target
    // grew around it, so the 4a appearance is unchanged.
    const swatchGeometry = await highlightRow.evaluate((row) => {
      const buttons = [...row.querySelectorAll<HTMLElement>('[data-testid="annotation-color-swatch"]')];
      return buttons.map((button) => {
        const box = button.getBoundingClientRect();
        const paint = button.firstElementChild?.getBoundingClientRect();
        return {
          width: box.width,
          height: box.height,
          centerX: box.x + box.width / 2,
          paintWidth: paint?.width ?? 0,
          paintHeight: paint?.height ?? 0,
        };
      });
    });
    expect(swatchGeometry.length).toBeGreaterThan(1);
    for (const swatch of swatchGeometry) {
      expect(swatch.width).toBeGreaterThanOrEqual(24);
      expect(swatch.height).toBeGreaterThanOrEqual(24);
      expect(swatch.paintWidth).toBeCloseTo(13, 1);
      expect(swatch.paintHeight).toBeCloseTo(13, 1);
    }
    for (let index = 1; index < swatchGeometry.length; index += 1) {
      const gap = swatchGeometry[index]!.centerX - swatchGeometry[index - 1]!.centerX;
      expect(gap).toBeGreaterThanOrEqual(24);
    }

    await app.window.screenshot({ path: join(VISUAL_DIR, 'annotations-4a-panel.png') });
    const panelShot = await browser.screenshot({
      path: join(VISUAL_DIR, 'annotations-4a-panel-only.png'),
    });
    expect(panelShot.byteLength).toBeGreaterThan(2048);
  });
});
