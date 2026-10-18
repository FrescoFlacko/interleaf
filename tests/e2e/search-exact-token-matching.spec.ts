import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchInterleaf, searchStatus, stubOpenDialog, type AppHandle } from './helpers';
import { makeMarkdownFixture } from '../fixtures/document-fixtures';

/**
 * Search must be exact and whole-token end to end: `Format` finds `format` in
 * any casing and never `formats`, `formatting`, `formatted` or `formation`.
 *
 * The FTS index is tokenized with `porter unicode61`, so every one of those
 * words is a `MATCH` candidate for `format`. Only the exact filter separates
 * them, which is why this runs against the real main-process database rather
 * than a stub, and why it asserts the retrieved set, the marked text in each
 * result card, and the painted document range together — those three surfaces
 * are the ones that must agree.
 */

const BODY = [
  '# Exact Token Rules',
  '',
  'The FORMAT rule applies here.',
  '',
  'Many formats plus formatting and formatted output appear here.',
  '',
  'Cluster formation completes here.',
  '',
  'A format_id column lives here.',
].join('\n');

async function searchFor(app: AppHandle, query: string): Promise<void> {
  const panel = app.window.getByTestId('search-panel');
  await panel.getByLabel('Search indexed text').fill(query);
  await panel.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(searchStatus(app)).toContainText(/result/);
}

/** The text of every `<mark>` painted across all result cards, in card order. */
async function cardMarkTexts(app: AppHandle): Promise<string[]> {
  return app.window.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="search-result-excerpt"] mark'))
      .map((mark) => mark.textContent)
  );
}

async function paintedRangeTexts(app: AppHandle): Promise<string[]> {
  return app.window.evaluate(() => {
    const highlight = CSS.highlights.get('interleaf-search');
    return highlight
      ? Array.from(highlight as Iterable<Range>).map((range) => Range.prototype.toString.call(range))
      : [];
  });
}

test.describe('Exact whole-token search matching', () => {
  let app: AppHandle;
  let fixtureDir: string;
  let markdownPath: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-search-exact-e2e-'));
    markdownPath = join(fixtureDir, 'Exact_Token_Rules.md');
    writeFileSync(markdownPath, makeMarkdownFixture({ title: 'Exact Token Rules', body: BODY }));
    app = await launchInterleaf();
  });

  test.afterEach(async () => {
    const userDataDir = app.userDataDir;
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('retrieves, marks and paints only the exact token across casings and boundaries', async () => {
    await stubOpenDialog(app, [markdownPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const documents = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    const entry = documents.find((candidate) => candidate.format === 'markdown');
    expect(entry).toBeDefined();
    if (!entry) return;

    await app.window.getByTestId(`read-doc-${entry.id}`).click();
    await expect(app.window.getByTestId('reader-view')).toBeVisible();
    await expect.poll(async () => app.window.evaluate(async (documentId) =>
      (await window.interleafAPI.search.getIndexState(documentId))?.status ?? 'missing', entry.id
    )).toBe('ready');
    await app.window.getByRole('tab', { name: 'Search' }).click();
    const panel = app.window.getByTestId('search-panel');
    const results = panel.getByRole('list', { name: 'Search results' });

    // Every casing of the exact token retrieves exactly the one passage that
    // contains it, and the card marks exactly that word.
    for (const casing of ['format', 'FORMAT', 'Format', 'FoRmAt']) {
      await searchFor(app, casing);
      await expect(results.getByRole('listitem')).toHaveCount(1);
      await expect(results.getByRole('listitem').first()).toContainText('The FORMAT rule applies here.');
      expect(await cardMarkTexts(app)).toEqual(['FORMAT']);
    }

    // Prefix-like and stem relatives are separate tokens, each retrieving only
    // its own passage — never each other's.
    for (const [query, passage] of [
      ['formats', 'Many formats plus formatting and formatted output appear here.'],
      ['formatting', 'Many formats plus formatting and formatted output appear here.'],
      ['formation', 'Cluster formation completes here.'],
      // Underscores join into one token, so `format_id` is not `format`.
      ['format_id', 'A format_id column lives here.'],
    ] as const) {
      await searchFor(app, query);
      await expect(results.getByRole('listitem')).toHaveCount(1);
      await expect(results.getByRole('listitem').first()).toContainText(passage);
      expect(await cardMarkTexts(app)).toEqual([query]);
    }

    // A word that exists nowhere as a whole token returns nothing, even though
    // `porter` stems it onto an indexed term.
    await searchFor(app, 'formatter');
    await expect(searchStatus(app)).toContainText('0 results.');
    await expect(results.getByRole('listitem')).toHaveCount(0);

    // Multi-word search stays AND over exact tokens.
    await searchFor(app, 'cluster formation');
    await expect(results.getByRole('listitem')).toHaveCount(1);
    expect(await cardMarkTexts(app)).toEqual(['Cluster', 'formation']);
    await searchFor(app, 'format formats');
    await expect(results.getByRole('listitem')).toHaveCount(0);

    // The document paint agrees with the card: the same single exact word.
    await searchFor(app, 'Format');
    await results.getByRole('button', { name: /Jump to/ }).first().click();
    await expect(searchStatus(app)).toContainText('Matched');
    await expect.poll(() => paintedRangeTexts(app)).toEqual(['FORMAT']);

    // A new executed query with no exact match clears the transient paint.
    await searchFor(app, 'formatter');
    await expect.poll(() => paintedRangeTexts(app)).toEqual([]);
    await expect.poll(async () => app.window.evaluate(() => CSS.highlights.has('interleaf-search'))).toBe(false);
    expect(await cardMarkTexts(app)).toEqual([]);
  });
});
