import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchInterleaf, stubOpenDialog, type AppHandle } from './helpers';
import {
  makeDocxFixture,
  makeEpubFixture,
  makeMarkdownFixture,
  makePdfFixture,
} from '../fixtures/document-fixtures';

test.describe('Defect 09: Reader text selection accuracy across document formats', () => {
  let app: AppHandle;
  let fixtureDir: string;
  let samplePdfPath: string;
  let sampleMdPath: string;
  let sampleDocxPath: string;
  let sampleEpubPath: string;

  test.beforeEach(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'interleaf-selection-accuracy-'));
    samplePdfPath = join(fixtureDir, 'Distributed_Architecture_Guide.pdf');
    sampleMdPath = join(fixtureDir, 'Local_First_Design.md');
    sampleDocxPath = join(fixtureDir, 'System_Specification.docx');
    sampleEpubPath = join(fixtureDir, 'Active_Reading_Handbook.epub');

    // PDF with Page 1 text near bottom (Y=80) and Page 2 text near top (Y=740)
    // so both are immediately adjacent across the page gap.
    writeFileSync(
      samplePdfPath,
      makePdfFixture({
        title: 'Distributed Architecture Guide',
        author: 'Martin Kleppmann',
        pageLines: [
          [
            'Distributed Systems Foundations: Consistency, Availability, and Partition Tolerance.',
          ],
          [
            'Cross-page continuous text selection ensures zero data loss during extraction.',
          ],
          [
            'Storage engines structure data for fast reads and reliable writes.',
          ],
        ],
        pageStartPositions: [
          [72, 80],
          [72, 740],
          [72, 720],
        ],
      })
    );

    writeFileSync(
      sampleMdPath,
      makeMarkdownFixture({
        title: 'Local First Design',
        author: 'Interleaf Team',
        useFrontmatter: false,
        body: `## System Architecture Overview

Interleaf provides local-first document processing and active reading workflows.

### Core Guarantees

All documents remain on local storage and render with high typography fidelity.`,
      })
    );

    writeFileSync(
      sampleDocxPath,
      makeDocxFixture({
        title: 'System Specification',
        author: 'Interleaf Team',
        bodyText: 'The reader engine decouples layout extraction from annotation persistence. Cross-paragraph highlights and notes are stored in normalized composite anchors.',
      })
    );

    writeFileSync(
      sampleEpubPath,
      makeEpubFixture({
        title: 'Active Reading Handbook',
        author: 'Interleaf Team',
        chapters: [
          {
            title: 'Chapter 1: Introduction to Active Reading',
            content: `
              <p>Active reading transforms passive consumption into deep analytical comprehension.</p>
              <p>Highlights and marginalia enable readers to converse directly with complex ideas.</p>
              <p>Multi-paragraph excerpts can be captured and submitted directly into agent tasks.</p>
            `,
          },
        ],
      })
    );

    app = await launchInterleaf();
  });

  test.afterEach(async () => {
    await app.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('captures cross-page PDF selections, persists composite highlights, maintains 200% zoom containment, and restores after restart', async () => {
    // 1. Import and open the multi-page PDF fixture
    await stubOpenDialog(app, [samplePdfPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const [pdfDoc] = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    expect(pdfDoc?.title).toBe('Distributed Architecture Guide');

    await app.window.getByTestId(`read-doc-${pdfDoc!.id}`).click();
    await expect(app.window.getByTestId('pdf-canvas-p1')).toBeVisible();
    await expect(app.window.getByTestId('pdf-textlayer-p1')).toBeVisible();
    await expect(app.window.getByTestId('pdf-textlayer-p2')).toBeVisible();

    // Scroll to the page boundary between Page 1 and Page 2
    await app.window.evaluate(() => {
      const container = document.querySelector('[data-testid="pdf-scroll-container"]');
      const p1 = document.querySelector('[data-page-number="1"]');
      if (container && p1) {
        const p1Bottom = (p1 as HTMLElement).offsetTop + (p1 as HTMLElement).offsetHeight;
        container.scrollTop = p1Bottom - container.clientHeight / 2;
      }
    });
    await app.window.waitForTimeout(400);

    // Helper to select text across page 1 and page 2
    const triggerPdfSelection = async () => {
      return app.window.evaluate(() => {
        const layer1 = document.querySelector('[data-testid="pdf-textlayer-p1"]');
        const layer2 = document.querySelector('[data-testid="pdf-textlayer-p2"]');
        if (!layer1 || !layer2) throw new Error('Layers not found');

        let startNode: Node | null = null;
        const w1 = document.createTreeWalker(layer1, NodeFilter.SHOW_TEXT);
        for (let n = w1.nextNode(); n; n = w1.nextNode()) {
          if ((n.textContent ?? '').includes('Distributed Systems')) {
            startNode = n;
            break;
          }
        }

        let endNode: Node | null = null;
        let endOffset = 0;
        const w2 = document.createTreeWalker(layer2, NodeFilter.SHOW_TEXT);
        for (let n = w2.nextNode(); n; n = w2.nextNode()) {
          if ((n.textContent ?? '').includes('Cross-page')) {
            endNode = n;
            endOffset = (n.textContent ?? '').length;
            break;
          }
        }

        if (!startNode || !endNode) throw new Error('Start or end node not found');

        const range = document.createRange();
        range.setStart(startNode, 0);
        range.setEnd(endNode, endOffset);
        const sel = document.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));

        return sel?.toString() ?? '';
      });
    };

    // 2. Both pages around the boundary are in the viewport.
    const boundaryRects = await app.window.evaluate(() => {
      const l1 = document.querySelector('[data-testid="pdf-textlayer-p1"]');
      const l2 = document.querySelector('[data-testid="pdf-textlayer-p2"]');
      const container = document.querySelector('[data-testid="pdf-scroll-container"]');
      const cRect = container?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
      const r1 = l1?.getBoundingClientRect();
      const r2 = l2?.getBoundingClientRect();
      return {
        p1Visible: Boolean(r1 && r1.bottom > cRect.top && r1.top < cRect.bottom),
        p2Visible: Boolean(r2 && r2.bottom > cRect.top && r2.top < cRect.bottom),
      };
    });
    expect(boundaryRects.p1Visible).toBe(true);
    expect(boundaryRects.p2Visible).toBe(true);

    // 3. A cross-page selection reaches the toolbar.
    const nativeSelectedText = await triggerPdfSelection();
    const expectedPdfText = 'Distributed Systems Foundations: Consistency, Availability, and Partition Tolerance.\nCross-page continuous text selection ensures zero data loss during extraction.';
    expect(nativeSelectedText).toBe(expectedPdfText);

    const pdfSelectionCoverage = await app.window.evaluate(() => {
      type RectMetrics = { left: number; right: number; top: number; bottom: number; width: number; height: number };
      const rectMetrics = (rect: DOMRect): RectMetrics => ({
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      });
      const findTextNode = (root: HTMLElement, phrase: string): Text | null => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if ((node.textContent ?? '').includes(phrase)) return node as Text;
        }
        return null;
      };
      const scanCanvasGlyphs = (canvas: HTMLCanvasElement, target: RectMetrics): RectMetrics | null => {
        const canvasRect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / canvasRect.width;
        const scaleY = canvas.height / canvasRect.height;
        if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) return null;
        const yStart = Math.max(0, Math.floor((target.top - canvasRect.top - 4) * scaleY));
        const yEnd = Math.min(canvas.height, Math.ceil((target.bottom - canvasRect.top + 4) * scaleY));
        if (yEnd <= yStart) return null;
        const pixels = canvas.getContext('2d')?.getImageData(0, yStart, canvas.width, yEnd - yStart).data;
        if (!pixels) return null;
        let minX = canvas.width;
        let maxX = -1;
        for (let y = 0; y < yEnd - yStart; y++) {
          for (let x = 0; x < canvas.width; x++) {
            const offset = (y * canvas.width + x) * 4;
            const alpha = pixels[offset + 3] ?? 0;
            const red = pixels[offset] ?? 255;
            const green = pixels[offset + 1] ?? 255;
            const blue = pixels[offset + 2] ?? 255;
            if (alpha > 0 && red + green + blue < 660) {
              minX = Math.min(minX, x);
              maxX = Math.max(maxX, x);
            }
          }
        }
        if (maxX < minX) return null;
        return {
          left: canvasRect.left + minX / scaleX,
          right: canvasRect.left + (maxX + 1) / scaleX,
          top: canvasRect.top + yStart / scaleY,
          bottom: canvasRect.top + yEnd / scaleY,
          width: (maxX + 1 - minX) / scaleX,
          height: (yEnd - yStart) / scaleY,
        };
      };

      const selection = document.getSelection();
      const nativeRange = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
      const expectedPages = [
        { page: 1, phrase: 'Distributed Systems', exact: 'Distributed Systems Foundations: Consistency, Availability, and Partition Tolerance.' },
        { page: 2, phrase: 'Cross-page', exact: 'Cross-page continuous text selection ensures zero data loss during extraction.' },
      ];
      return {
        selectedText: selection?.toString() ?? '',
        start: nativeRange?.startContainer.nodeType === Node.TEXT_NODE ? { text: nativeRange.startContainer.textContent ?? '', offset: nativeRange.startOffset } : null,
        end: nativeRange?.endContainer.nodeType === Node.TEXT_NODE ? { text: nativeRange.endContainer.textContent ?? '', offset: nativeRange.endOffset } : null,
        pages: expectedPages.map(({ page, phrase, exact }) => {
          const layer = document.querySelector<HTMLElement>(`[data-testid="pdf-textlayer-p${String(page)}"]`);
          const canvas = document.querySelector<HTMLCanvasElement>(`[data-testid="pdf-canvas-p${String(page)}"]`);
          const textNode = layer ? findTextNode(layer, phrase) : null;
          if (!layer || !canvas || !textNode || !nativeRange) return { page, exact, text: textNode?.textContent ?? null, selected: null, textRect: null, glyphRect: null, layer: null, computed: null };
          const textRange = document.createRange();
          textRange.selectNodeContents(textNode);
          const textRect = textRange.getBoundingClientRect();
          const candidate = Array.from(nativeRange.getClientRects()).find((rect) => Math.abs(rect.top - textRect.top) <= 3 && Math.abs(rect.height - textRect.height) <= 3);
          const span = textNode.parentElement;
          const layerRect = layer.getBoundingClientRect();
          return {
            page,
            exact,
            text: textNode.data,
            selected: candidate ? rectMetrics(candidate) : null,
            textRect: rectMetrics(textRect),
            glyphRect: scanCanvasGlyphs(canvas, rectMetrics(textRect)),
            layer: rectMetrics(layerRect),
            computed: span ? {
              fontSize: getComputedStyle(span).fontSize,
              transform: getComputedStyle(span).transform,
              fontHeight: span.style.getPropertyValue('--font-height'),
              scaleX: span.style.getPropertyValue('--scale-x'),
              totalScaleFactor: getComputedStyle(layer).getPropertyValue('--total-scale-factor'),
            } : null,
          };
        }),
      };
    });
    expect(pdfSelectionCoverage.selectedText).toBe(expectedPdfText);
    expect(pdfSelectionCoverage.start?.offset).toBe(0);
    expect(pdfSelectionCoverage.start?.text).toContain('Distributed Systems Foundations');
    expect(pdfSelectionCoverage.end?.offset).toBe(pdfSelectionCoverage.end?.text.length);
    expect(pdfSelectionCoverage.end?.text).toContain('Cross-page continuous text selection');
    for (const page of pdfSelectionCoverage.pages) {
      expect(page.text).toBe(page.exact);
      expect(page.selected).not.toBeNull();
      expect(page.textRect).not.toBeNull();
      expect(page.glyphRect).not.toBeNull();
      expect(page.selected!.left).toBeLessThanOrEqual(page.glyphRect!.left + 3);
      expect(page.selected!.right).toBeGreaterThanOrEqual(page.glyphRect!.right - 3);
    }

    const toolbar = app.window.getByTestId('annotation-selection-toolbar');
    await expect(toolbar).toBeVisible();

    // 4. Constrained 200% zoom factor in a 960x608 BrowserWindow
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.setSize(960, 608);
        win.webContents.setZoomFactor(2.0);
      }
    });
    await app.window.setViewportSize({ width: 960, height: 608 });
    await app.window.waitForTimeout(400);

    // Scroll to page boundary under 200% zoom
    await app.window.evaluate(() => {
      const container = document.querySelector('[data-testid="pdf-scroll-container"]');
      const p1 = document.querySelector('[data-page-number="1"]');
      if (container && p1) {
        const p1Bottom = (p1 as HTMLElement).offsetTop + (p1 as HTMLElement).offsetHeight;
        container.scrollTop = p1Bottom - container.clientHeight / 2;
      }
    });
    await app.window.waitForTimeout(400);

    // Re-dispatch selection to update toolbar geometry under 200% zoom
    const zoomedNativeSelectedText = await triggerPdfSelection();
    expect(zoomedNativeSelectedText).toBe(expectedPdfText);
    await expect(toolbar).toBeVisible();
    const zoomedSelectionGeometry = await app.window.evaluate(() => {
      const selection = document.getSelection();
      const range = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
      const expectedPages = [
        { page: 1, phrase: 'Distributed Systems', exact: 'Distributed Systems Foundations: Consistency, Availability, and Partition Tolerance.' },
        { page: 2, phrase: 'Cross-page', exact: 'Cross-page continuous text selection ensures zero data loss during extraction.' },
      ];
      const pages = expectedPages.map(({ page, phrase, exact }) => {
        const layer = document.querySelector<HTMLElement>(`[data-testid="pdf-textlayer-p${String(page)}"]`);
        if (!layer || !range) return { page, exact, text: null, selected: null, textRect: null };
        const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
        let textNode: Text | null = null;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if ((node.textContent ?? '').includes(phrase)) {
            textNode = node as Text;
            break;
          }
        }
        if (!textNode) return { page, exact, text: null, selected: null, textRect: null };
        const fullTextRange = document.createRange();
        fullTextRange.selectNodeContents(textNode);
        const textRect = fullTextRange.getBoundingClientRect();
        const selected = Array.from(range.getClientRects()).find((rect) => Math.abs(rect.top - textRect.top) <= 4 && Math.abs(rect.height - textRect.height) <= 4);
        return {
          page,
          exact,
          text: textNode.data,
          selected: selected ? { left: selected.left, right: selected.right, top: selected.top, bottom: selected.bottom } : null,
          textRect: { left: textRect.left, right: textRect.right, top: textRect.top, bottom: textRect.bottom },
        };
      });
      return {
        selectedText: selection?.toString() ?? '',
        startOffset: range?.startOffset ?? -1,
        endOffset: range?.endOffset ?? -1,
        endLength: range?.endContainer.textContent?.length ?? -1,
        pages,
      };
    });
    expect(zoomedSelectionGeometry.selectedText).toBe(expectedPdfText);
    expect(zoomedSelectionGeometry.startOffset).toBe(0);
    expect(zoomedSelectionGeometry.endOffset).toBe(zoomedSelectionGeometry.endLength);
    for (const page of zoomedSelectionGeometry.pages) {
      expect(page.text).toBe(page.exact);
      expect(page.selected).not.toBeNull();
      expect(page.textRect).not.toBeNull();
      expect(page.selected!.left).toBeLessThanOrEqual(page.textRect!.left + 3);
      expect(page.selected!.right).toBeGreaterThanOrEqual(page.textRect!.right - 3);
    }
    // Assert 4-sided bounding containment of the floating toolbar
    const containment = await app.window.evaluate(() => {
      const tb = document.querySelector('[data-testid="annotation-selection-toolbar"]');
      if (!tb) return null;
      const rect = tb.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const bodyHasScroll = document.body.scrollWidth > window.innerWidth + 1;
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        vw,
        vh,
        fitsHorizontally: rect.left >= 0 && rect.right <= vw + 1,
        fitsVertically: rect.top >= 0 && rect.bottom <= vh + 1,
        noBodyOverflow: !bodyHasScroll,
      };
    });
    expect(containment).not.toBeNull();
    expect(containment!.fitsHorizontally).toBe(true);
    expect(containment!.fitsVertically).toBe(true);
    expect(containment!.noBodyOverflow).toBe(true);

    // Reset zoom factor back to 1.0
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.setSize(1280, 800);
        win.webContents.setZoomFactor(1.0);
      }
    });
    await app.window.setViewportSize({ width: 1280, height: 800 });
    await app.window.waitForTimeout(300);

    // Re-establish selection at 1.0 zoom
    await triggerPdfSelection();
    await expect(toolbar).toBeVisible();

    // 5. Create cross-page Blue highlight
    await toolbar.getByRole('button', { name: 'Blue highlight' }).click();

    // Verify stored composite anchor in SQLite
    await expect.poll(async () => app.window.evaluate(async (docId) => {
      const list = await window.interleafAPI.annotations.list(docId, { limit: 10 });
      return list.length;
    }, pdfDoc!.id)).toBe(1);

    const [savedAnnotation] = await app.window.evaluate(async (docId) =>
      window.interleafAPI.annotations.list(docId, { limit: 10 }),
    pdfDoc!.id);
    expect(savedAnnotation).toBeDefined();
    if (savedAnnotation?.anchor.format !== 'pdf') {
      throw new Error('Expected saved PDF annotation');
    }

    // Exact string equality between native Selection.toString and savedAnnotation.selectedText
    expect(savedAnnotation.selectedText).toBe(nativeSelectedText);
    expect(savedAnnotation.color).toBe('blue');
    expect(savedAnnotation.status).toBe('anchored');

    // Assert exactly two segments with pageIndex 0 and 1
    const pdfAnchor = savedAnnotation.anchor;
    expect(pdfAnchor.pageIndex).toBe(0);
    expect(pdfAnchor.pageLabel).toBe('1–2');
    expect(pdfAnchor.segments).toBeDefined();
    expect(pdfAnchor.segments).toHaveLength(2);
    expect(pdfAnchor.segments?.[0]?.pageIndex).toBe(0);
    expect(pdfAnchor.segments?.[1]?.pageIndex).toBe(1);
    expect(pdfAnchor.segments?.[0]?.quote.exact).toBe('Distributed Systems Foundations: Consistency, Availability, and Partition Tolerance.');
    expect(pdfAnchor.segments?.[1]?.quote.exact).toBe('Cross-page continuous text selection ensures zero data loss during extraction.');
    // Assert CSS.highlights contains exactly 2 ranges painted for 'interleaf-blue'
    const highlightStats = await app.window.evaluate(() => {
      const customCss = CSS as { highlights?: Map<string, { size: number }> };
      const hl = customCss.highlights?.get('interleaf-blue');
      return {
        hasBlue: customCss.highlights?.has('interleaf-blue') ?? false,
        rangeCount: hl?.size ?? 0,
      };
    });
    expect(highlightStats.hasBlue).toBe(true);
    expect(highlightStats.rangeCount).toBe(2);

    // 6. Relaunch Interleaf with preserved userDataDir and verify highlight restoration on mounted pages
    const userDataDir = app.userDataDir;
    await app.close({ preserveUserData: true });

    const secondApp = await launchInterleaf({ userDataDir });
    try {
      await expect(secondApp.window.getByTestId('library-view')).toBeVisible();
      await secondApp.window.getByTestId(`read-doc-${pdfDoc!.id}`).click();
      await expect(secondApp.window.getByTestId('pdf-textlayer-p1')).toBeVisible();

      // Verify restored highlight registered in CSS.highlights with 2 painted ranges
      await expect.poll(async () => secondApp.window.evaluate(() => {
        const customCss = CSS as { highlights?: Map<string, { size: number }> };
        return customCss.highlights?.get('interleaf-blue')?.size ?? 0;
      })).toBe(2);
    } finally {
      await secondApp.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('captures cross-block Markdown selections and persists composite highlights with reverse selection support', async () => {
    await stubOpenDialog(app, [sampleMdPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const [mdDoc] = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    expect(mdDoc?.title).toBe('Local First Design');

    await app.window.getByTestId(`read-doc-${mdDoc!.id}`).click();
    await expect(app.window.getByTestId('markdown-content-wrapper')).toBeVisible();

    // Select across Block 0 (heading) and Block 1 (paragraph) using a reverse selection (setBaseAndExtent from Block 1 backward to Block 0)
    const nativeSelectedText = await app.window.evaluate(() => {
      const b0 = document.querySelector('[data-markdown-block="0"]');
      const b1 = document.querySelector('[data-markdown-block="1"]');
      if (!b0 || !b1) throw new Error('Markdown blocks not found');

      let startNode: Node | null = null;
      const w0 = document.createTreeWalker(b0, NodeFilter.SHOW_TEXT);
      for (let n = w0.nextNode(); n; n = w0.nextNode()) {
        if ((n.textContent ?? '').includes('System')) {
          startNode = n;
          break;
        }
      }

      let endNode: Node | null = null;
      let endOffset = 0;
      const w1 = document.createTreeWalker(b1, NodeFilter.SHOW_TEXT);
      for (let n = w1.nextNode(); n; n = w1.nextNode()) {
        if ((n.textContent ?? '').includes('Interleaf')) {
          endNode = n;
          endOffset = (n.textContent ?? '').length;
          break;
        }
      }

      if (!startNode || !endNode) throw new Error('Markdown start/end node not found');

      // Execute a real reverse selection: anchor/base at endNode, focus/extent at startNode
      const sel = document.getSelection();
      sel?.removeAllRanges();
      sel?.setBaseAndExtent(endNode, endOffset, startNode, 0);
      document.dispatchEvent(new Event('selectionchange'));

      return sel?.toString() ?? '';
    });

    expect(nativeSelectedText).toContain('System Architecture Overview');
    expect(nativeSelectedText).toContain('Interleaf');

    const toolbar = app.window.getByTestId('annotation-selection-toolbar');
    await expect(toolbar).toBeVisible();

    // Create Green highlight
    await toolbar.getByRole('button', { name: 'Green highlight' }).click();

    await expect.poll(async () => app.window.evaluate(async (docId) => {
      const list = await window.interleafAPI.annotations.list(docId, { limit: 10 });
      return list.length;
    }, mdDoc!.id)).toBe(1);

    const [savedAnnotation] = await app.window.evaluate(async (docId) =>
      window.interleafAPI.annotations.list(docId, { limit: 10 }),
    mdDoc!.id);
    expect(savedAnnotation).toBeDefined();
    if (savedAnnotation?.anchor.format !== 'markdown') {
      throw new Error('Expected saved Markdown annotation');
    }

    // Exact string equality
    expect(savedAnnotation.selectedText).toBe(nativeSelectedText);
    expect(savedAnnotation.color).toBe('green');
    expect(savedAnnotation.status).toBe('anchored');

    // Assert exactly two segments in correct ascending order (Block 0, Block 1)
    const mdAnchor = savedAnnotation.anchor;
    expect(mdAnchor.blockIndex).toBe(0);
    expect(mdAnchor.segments).toBeDefined();
    expect(mdAnchor.segments).toHaveLength(2);
    expect(mdAnchor.segments?.[0]?.blockIndex).toBe(0);
    expect(mdAnchor.segments?.[1]?.blockIndex).toBe(1);
    // Assert highlight range count 2
    const highlightStats = await app.window.evaluate(() => {
      const customCss = CSS as { highlights?: Map<string, { size: number }> };
      return customCss.highlights?.get('interleaf-green')?.size ?? 0;
    });
    expect(highlightStats).toBe(2);
  });

  test('captures cross-paragraph DOCX selections and persists composite highlights', async () => {
    await stubOpenDialog(app, [sampleDocxPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const [docxDoc] = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    expect(docxDoc?.title).toBe('System Specification');

    await app.window.getByTestId(`read-doc-${docxDoc!.id}`).click();
    await expect(app.window.getByTestId('docx-scroll-container')).toBeVisible();

    // Select across Paragraph 0 (heading) and Paragraph 1 (body text)
    const nativeSelectedText = await app.window.locator('[data-docx-paragraph="0"]').evaluate((p0) => {
      const p1 = p0.ownerDocument.querySelector('[data-docx-paragraph="1"]');
      if (!p1) throw new Error('DOCX paragraph 1 not found');

      let startNode: Node | null = null;
      const w0 = p0.ownerDocument.createTreeWalker(p0, NodeFilter.SHOW_TEXT);
      for (let n = w0.nextNode(); n; n = w0.nextNode()) {
        if ((n.textContent ?? '').trim().length > 0) {
          startNode = n;
          break;
        }
      }

      let endNode: Node | null = null;
      let endOffset = 0;
      const w1 = p0.ownerDocument.createTreeWalker(p1, NodeFilter.SHOW_TEXT);
      for (let n = w1.nextNode(); n; n = w1.nextNode()) {
        if ((n.textContent ?? '').trim().length > 0) {
          endNode = n;
          endOffset = (n.textContent ?? '').length;
          break;
        }
      }

      if (!startNode || !endNode) throw new Error('DOCX start/end node not found');
      const range = p0.ownerDocument.createRange();
      range.setStart(startNode, 0);
      range.setEnd(endNode, endOffset);
      const sel = p0.ownerDocument.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      p0.ownerDocument.dispatchEvent(new Event('selectionchange'));

      return sel?.toString() ?? '';
    });

    expect(nativeSelectedText.length).toBeGreaterThan(0);

    const toolbar = app.window.getByTestId('annotation-selection-toolbar');
    await expect(toolbar).toBeVisible();

    // Create Yellow highlight
    await toolbar.getByRole('button', { name: 'Yellow highlight' }).click();

    await expect.poll(async () => app.window.evaluate(async (docId) => {
      const list = await window.interleafAPI.annotations.list(docId, { limit: 10 });
      return list.length;
    }, docxDoc!.id)).toBe(1);

    const [savedAnnotation] = await app.window.evaluate(async (docId) =>
      window.interleafAPI.annotations.list(docId, { limit: 10 }),
    docxDoc!.id);
    expect(savedAnnotation).toBeDefined();
    if (savedAnnotation?.anchor.format !== 'docx') {
      throw new Error('Expected saved DOCX annotation');
    }

    // Exact string equality
    expect(savedAnnotation.selectedText).toBe(nativeSelectedText);
    expect(savedAnnotation.color).toBe('yellow');
    expect(savedAnnotation.status).toBe('anchored');
    // Assert exactly two segments in correct ascending order
    const docxAnchor = savedAnnotation.anchor;
    expect(docxAnchor.paragraphIndex).toBe(0);
    expect(docxAnchor.segments).toBeDefined();
    expect(docxAnchor.segments).toHaveLength(2);
    expect(docxAnchor.segments?.[0]?.paragraphIndex).toBe(0);
    expect(docxAnchor.segments?.[1]?.paragraphIndex).toBe(1);
    // Assert highlight range count 2
    const highlightStats = await app.window.evaluate(() => {
      const customCss = CSS as { highlights?: Map<string, { size: number }> };
      return customCss.highlights?.get('interleaf-yellow')?.size ?? 0;
    });
    expect(highlightStats).toBe(2);
  });

  test('captures cross-paragraph EPUB selections within the active section', async () => {
    await stubOpenDialog(app, [sampleEpubPath]);
    await app.window.getByTestId('import-files-button').click();
    await expect(app.window.getByTestId('success-banner')).toBeVisible();

    const [epubDoc] = await app.window.evaluate(async () =>
      window.interleafAPI.library.listDocuments()
    );
    expect(epubDoc?.title).toBe('Active Reading Handbook');

    await app.window.getByTestId(`read-doc-${epubDoc!.id}`).click();
    await expect(app.window.locator('iframe[title="Ebook Content"]')).toBeVisible();

    // Select across paragraph 0 and paragraph 1 inside the iframe
    const nativeSelectedText = await app.window.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="Ebook Content"]');
      const doc = iframe?.contentDocument;
      if (!doc) throw new Error('EPUB iframe contentDocument not available');

      const paragraphs = doc.querySelectorAll('p');
      const p1 = paragraphs[0];
      const p2 = paragraphs[1];
      if (!p1 || !p2) throw new Error('EPUB paragraphs not found');

      const range = doc.createRange();
      range.setStart(p1.firstChild!, 5);
      range.setEnd(p2.firstChild!, 25);
      const sel = doc.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      doc.dispatchEvent(new Event('selectionchange'));

      return sel?.toString() ?? '';
    });

    expect(nativeSelectedText.length).toBeGreaterThan(0);

    const toolbar = app.window.getByTestId('annotation-selection-toolbar');
    await expect(toolbar).toBeVisible();

    // Create Pink highlight
    await toolbar.getByRole('button', { name: 'Pink highlight' }).click();

    await expect.poll(async () => app.window.evaluate(async (docId) => {
      const list = await window.interleafAPI.annotations.list(docId, { limit: 10 });
      return list.length;
    }, epubDoc!.id)).toBe(1);

    const [savedAnnotation] = await app.window.evaluate(async (docId) =>
      window.interleafAPI.annotations.list(docId, { limit: 10 }),
    epubDoc!.id);
    expect(savedAnnotation).toBeDefined();
    if (savedAnnotation?.anchor.format !== 'epub') {
      throw new Error('Expected saved EPUB annotation');
    }

    // Exact string equality
    expect(savedAnnotation.selectedText).toBe(nativeSelectedText);
    expect(savedAnnotation.color).toBe('pink');
    expect(savedAnnotation.status).toBe('anchored');

    // Assert highlight is registered in iframe CSS.highlights
    const highlightStats = await app.window.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="Ebook Content"]');
      const win = iframe?.contentWindow as (Window & { CSS?: { highlights?: Map<string, { size: number }> } }) | null;
      return win?.CSS?.highlights?.get('interleaf-pink')?.size ?? 0;
    });
    expect(highlightStats).toBe(1);
  });
});
