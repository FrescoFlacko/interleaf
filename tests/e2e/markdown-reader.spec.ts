import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchInterleaf, returnToLibrary, stubOpenDialog, type AppHandle, openCompanionPanel, restoreDefaultWindowSize } from './helpers';
import { makeMarkdownFixture } from '../fixtures/document-fixtures';

test.describe('Markdown Reader End-to-End Workflow', () => {
  let app: AppHandle;
  let fixtureDir: string;
  let mdPath: string;
  let markdownPath: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-md-e2e-'));
    mdPath = join(fixtureDir, 'Research_Notes.md');
    writeFileSync(
      mdPath,
      makeMarkdownFixture({
        title: 'Research Notes',
        author: 'Test Author',
        body: `# Research Notes

## Introduction

This is a **bold** and *italic* paragraph with \`inline code\` and ~~strikethrough~~ text.

### Formatting Examples

> A blockquote with a [safe link](https://example.com "Example") inside.

- Unordered item one
- Unordered item two

1. Ordered first
2. Ordered second

- [x] Completed task
- [ ] Pending task

\`\`\`javascript
function greet(name) {
  return 'Hello, ' + name;
}
\`\`\`

| Header A | Header B |
| -------- | -------- |
| Cell 1   | Cell 2   |
| Cell 3   | Cell 4   |

---

### Security Test

[safe link](https://example.com)
[unsafe link](javascript:alert(1))
<script>alert('xss')</script>
<img src="x" onerror="alert('xss')">

## Conclusion

Final paragraph with ***bold italic*** text and a unique searchable phrase.

### Bulleted Claims

- **Operational Excellence. **Training a frontier model is an enormous engineering effort.
- **Alignment.** We made clear progress in alignment, training models to be honest.
`,
      })
    );
    markdownPath = join(fixtureDir, 'Notes.markdown');
    writeFileSync(
      markdownPath,
      makeMarkdownFixture({
        title: 'Markdown Extension',
        useFrontmatter: true,
      })
    );
    app = await launchInterleaf();
    await restoreDefaultWindowSize(app);
    await openCompanionPanel(app);
  });

  test.afterEach(async () => {
    const userDataDir = app.userDataDir;
    await app.electronApp.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('imports .md and .markdown, renders semantic headings, and persists across reopen', async () => {
    // Import both files
    await stubOpenDialog(app, [mdPath, markdownPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    // Verify both documents are in the library
    const documents = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    expect(documents).toHaveLength(2);
    const mdDoc = documents.find((d) => d.format === 'markdown' && d.title === 'Research Notes');
    const markdownDoc = documents.find((d) => d.format === 'markdown' && d.title === 'Markdown Extension');
    expect(mdDoc).toBeDefined();
    expect(markdownDoc).toBeDefined();
    expect(mdDoc!.author).toBe('Test Author');

    // Open the .md document
    await app.window.getByTestId(`read-doc-${mdDoc!.id}`).click();
    await expect(app.window.getByTestId('reader-view')).toBeVisible();
    // The header no longer carries a format badge; the Markdown content
    // wrapper below is the evidence that the format was routed correctly.

    // Verify semantic headings render as actual heading elements (no literal hashes)
    const content = app.window.getByTestId('markdown-content-wrapper');
    await expect(content.getByRole('heading', { level: 1, name: 'Research Notes' })).toBeVisible();
    await expect(content.getByRole('heading', { level: 2, name: 'Introduction' })).toBeVisible();
    await expect(content.getByRole('heading', { level: 3, name: 'Formatting Examples' })).toBeVisible();

    // Verify heading text does not contain literal '#' markers
    const headingTexts = await app.window.locator('[data-testid^="markdown-heading-"]').allInnerTexts();
    for (const text of headingTexts) {
      expect(text).not.toMatch(/^#{1,6}\s/);
    }

    // Verify representative formatting
    await expect(app.window.locator('strong').first()).toBeVisible();
    await expect(app.window.locator('em').first()).toBeVisible();
    await expect(app.window.locator('code').first()).toBeVisible();
    await expect(app.window.locator('blockquote').first()).toBeVisible();

    // Verify table rendering
    await expect(app.window.locator('.markdown-table th').first()).toContainText('Header A');
    await expect(app.window.locator('.markdown-table td').first()).toContainText('Cell 1');

    // Verify code block
    await expect(app.window.locator('[data-testid^="markdown-code-block-"]').first()).toContainText('function greet');
  });

  test('scales headings, code and tables with the reader text size', async () => {
    await stubOpenDialog(app, [mdPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();
    const [doc] = await app.window.evaluate(async () => window.interleafAPI.library.listDocuments());
    await app.window.getByTestId(`read-doc-${doc!.id}`).click();
    const content = app.window.getByTestId('markdown-content-wrapper');
    await expect(content.getByRole('heading', { level: 1, name: 'Research Notes' })).toBeVisible();

    // Each size divided by the body text size: a ratio that holds while the text grows.
    const ratios = () => content.evaluate((wrapper) => {
      const size = (selector: string) => Number.parseFloat(getComputedStyle(wrapper.querySelector(selector)!).fontSize);
      const body = Number.parseFloat(getComputedStyle(wrapper).fontSize);
      return {
        body,
        h1: size('h1') / body,
        h2: size('h2') / body,
        h3: size('h3') / body,
        code: size('.markdown-code-block') / body,
        table: size('.markdown-table') / body,
      };
    });
    const before = await ratios();

    await app.window.getByTestId('document-settings-button').click();
    await app.window.getByTestId('zoom-in-button').click();
    await app.window.getByTestId('zoom-in-button').click();
    await app.window.keyboard.press('Escape');
    await expect.poll(async () => (await ratios()).body).toBeGreaterThan(before.body);

    const after = await ratios();
    expect(after.h1).toBeCloseTo(before.h1, 2);
    expect(after.h2).toBeCloseTo(before.h2, 2);
    expect(after.h3).toBeCloseTo(before.h3, 2);
    expect(after.code).toBeCloseTo(before.code, 2);
    expect(after.table).toBeCloseTo(before.table, 2);
    expect(after.h1).toBeGreaterThan(after.h2);
    expect(after.h2).toBeGreaterThan(after.h3);
    expect(after.h3).toBeGreaterThan(1);
  });

  test('provides TOC navigation and search', async () => {
    await stubOpenDialog(app, [mdPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const [document] = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    await app.window.getByTestId(`read-doc-${document!.id}`).click();
    await expect(app.window.getByTestId('reader-view')).toBeVisible();

    // Open TOC and verify heading-based navigation
    await app.window.getByTestId('toggle-toc-button').click();
    const outline = app.window.getByTestId('reader-outline-sidebar');
    await expect(outline.getByText('Introduction')).toBeVisible();
    await expect(outline.getByText('Conclusion')).toBeVisible();

    // Navigate via TOC
    await outline.getByText('Conclusion').click();
    await expect(app.window.getByRole('heading', { level: 2, name: 'Conclusion' })).toBeVisible();
  });

  test('scripts, event handlers, and raw HTML cannot execute or escape', async () => {
    await stubOpenDialog(app, [mdPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const [document] = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    await app.window.getByTestId(`read-doc-${document!.id}`).click();
    await expect(app.window.getByTestId('reader-view')).toBeVisible();

    // Check no script elements are rendered in the content
    const scrollContainer = app.window.getByTestId('markdown-scroll-container');
    const scriptCount = await scrollContainer.locator('script').count();
    expect(scriptCount).toBe(0);

    // Check no event handler attributes on any img
    const imgElements = await scrollContainer.locator('img').all();
    for (const img of imgElements) {
      const onerror = await img.getAttribute('onerror');
      expect(onerror).toBeNull();
    }

    // Verify the raw HTML <script> tag is treated as inert text
    const innerHTML = await scrollContainer.innerHTML();
    expect(innerHTML).not.toContain('<script>');

    // Check that javascript: links are not rendered as clickable links
    const unsafeLinks = await scrollContainer.locator('a[href^="javascript:"]').count();
    expect(unsafeLinks).toBe(0);

    // Check external link has noopener/noreferrer, data-external-link, and
    // is announced actionable.
    const externalLink = scrollContainer.locator('a[data-external-link="true"]').first();
    await expect(externalLink).toBeVisible();
    expect(await externalLink.getAttribute('rel')).toBe('noopener noreferrer');
    expect(await externalLink.getAttribute('aria-disabled')).toBeNull();
  });

  test('saves and restores reading position', async () => {
    await stubOpenDialog(app, [mdPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const [document] = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    await app.window.getByTestId(`read-doc-${document!.id}`).click();
    await expect(app.window.getByTestId('reader-view')).toBeVisible();
    // Store a reading position at blockIndex 3
    await app.window.evaluate(async (docId) => {
      await window.interleafAPI.library.updateReadingPosition(
        docId,
        { format: 'markdown', blockIndex: 3, progression: 0.3 },
        0.3
      );
    }, document!.id);

    // Return to library and reopen
    await returnToLibrary(app);
    await app.window.getByTestId(`read-doc-${document!.id}`).click();
    await expect(app.window.getByTestId('reader-view')).toBeVisible();

    // Verify position was restored in database
    await expect.poll(async () => {
      const [saved] = await app.window.evaluate(async () =>
        window.interleafAPI.library.listDocuments()
      );
      const location = saved?.readingPosition?.location;
      return location?.format === 'markdown' ? location.blockIndex : -1;
    }).toBe(3);

    // Verify the formatting examples heading (block 3) is visible
    await expect(app.window.getByRole('heading', { level: 3, name: 'Formatting Examples' })).toBeVisible();
  });

  test('offers the annotation toolbar for a selection inside a later list item', async () => {
    await stubOpenDialog(app, [mdPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const [mdDocument] = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    await app.window.getByTestId(`read-doc-${mdDocument!.id}`).click();
    await expect(app.window.getByTestId('reader-view')).toBeVisible();

    await expect(
      app.window.getByRole('heading', { level: 3, name: 'Bulleted Claims' })
    ).toBeVisible();

    // Sweep the second bullet: it opens inside <strong> and ends in the plain
    // text after it, which is how the reported article's list items are built.
    const selectedText = await app.window.evaluate(() => {
      // The appended "Bulleted Claims" list ends the document, so its second
      // and last item is the last list item rendered anywhere in the reader.
      const items = document.querySelectorAll('.markdown-list-item');
      const item = items[items.length - 1]!;
      const strong = item.querySelector('strong')!;
      const bold = strong.firstChild!;
      const trailing = strong.nextSibling!;
      const range = document.createRange();
      range.setStart(bold, 0);
      range.setEnd(trailing, trailing.textContent!.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return selection.toString();
    });
    expect(selectedText).toContain('Alignment.');

    const toolbar = app.window.getByTestId('annotation-selection-toolbar');
    await expect(toolbar).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Yellow highlight' })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Add note' })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Ask AI' })).toBeVisible();

    // The highlight it creates survives a reopen, which only a resolvable
    // anchor in the second list item can do.
    await toolbar.getByRole('button', { name: 'Yellow highlight' }).click();
    await expect.poll(async () =>
      app.window.evaluate(async (docId) =>
        (await window.interleafAPI.annotations.list(docId)).length,
      mdDocument!.id)
    ).toBe(1);

    await returnToLibrary(app);
    await app.window.getByTestId(`read-doc-${mdDocument!.id}`).click();
    await expect(app.window.getByTestId('reader-view')).toBeVisible();
    await expect.poll(async () =>
      app.window.evaluate(async (docId) => {
        const [annotation] = await window.interleafAPI.annotations.list(docId);
        return annotation!.status;
      }, mdDocument!.id)
    ).toBe('anchored');
  });

  test('indexes markdown text for search/AI context extraction', async () => {
    await stubOpenDialog(app, [mdPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const [document] = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    await app.window.getByTestId(`read-doc-${document!.id}`).click();
    await expect(app.window.getByTestId('reader-view')).toBeVisible();

    // Wait for search indexer to finish background chunk indexing
    await expect.poll(async () => app.window.evaluate(async (docId) =>
      (await window.interleafAPI.search.getIndexState(docId))?.status,
    document!.id)).toBe('ready');

    // Query the search API directly
    const searchResults = await app.window.evaluate(async (docId) =>
      window.interleafAPI.search.searchDocument(docId, 'unique searchable phrase'),
    document!.id);
    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults[0]?.location.format).toBe('markdown');
    expect(searchResults[0]?.excerpt).toContain('unique searchable phrase');
    // Query via search companion tab in the UI
    await app.window.getByRole('tab', { name: 'Search' }).click();
    await app.window.getByLabel('Search indexed text').fill('unique searchable phrase');
    await app.window.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(app.window.getByText(/unique searchable phrase/i).last()).toBeVisible();
  });
});
