// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { DocumentCard } from '../../src/renderer/features/library/components/DocumentCard';
import { formatFileSize } from '../../src/renderer/features/library/document-format';
import { coverGradientClass } from '../../src/renderer/features/library/components/DocumentCover';
import { resetPreviewCacheForTesting } from '../../src/renderer/features/library/components/DocumentPreview';
import type { DocumentMetadata } from '@shared/types/document';
import { cssRule, mediaBlock, readGlobalCss } from './support/stylesheet-rules';

/**
 * Focused coverage for the cover-first library card (reference 7a): the cover
 * is the card, the scrim carries the title and author only, and progress reads
 * once — as a hairline on the bottom edge that exposes its own progressbar
 * semantics rather than a duplicate visible percentage.
 */

const globalCss = readGlobalCss();

/** The declarations of one `.ml-card-hover` rule, by its exact selector. */
const cardHoverRule = (selector: string): string => cssRule(globalCss, selector);

/** The fine-pointer `@media` block that gates the card hover. */
const hoverGatedCardRules = (): string =>
  mediaBlock(globalCss, '@media (hover: hover) and (pointer: fine)', 'ml-card-hover');

/** Cover type is solid white, never an opacity-composed white. */
function expectSolidWhiteType(el: Element): void {
  expect(el.className).toMatch(/(^|\s)text-white(\s|$)/);
  expect(el.className).not.toMatch(/text-white\/\d+/);
}

function makeDoc(overrides?: Partial<DocumentMetadata>): DocumentMetadata {
  return {
    id: 'cover-1',
    title: 'The Annotated Turing',
    author: 'Charles Petzold',
    format: 'pdf',
    storageMode: 'managed',
    fileSize: 2 * 1024 * 1024,
    fileMtimeMs: 1,
    fileHash: 'hash-cover-1',
    pageCount: 400,
    folderId: null,
    storageHealth: 'ok',
    readingPosition: null,
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
    source: null,
    ...overrides,
  };
}

describe('Library cover-first card (7a)', () => {
  beforeEach(() => {
    cleanup();
    resetPreviewCacheForTesting();
    class MockIntersectionObserver implements IntersectionObserver {
      readonly root: Element | Document | null = null;
      readonly rootMargin: string = '0px';
      readonly scrollMargin = '0px 0px 0px 0px';
      readonly thresholds: readonly number[] = [0];
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      takeRecords = vi.fn(() => []);
    }
    window.IntersectionObserver = MockIntersectionObserver;
  });

  afterEach(() => {
    cleanup();
    resetPreviewCacheForTesting();
  });

  test('the card is a single full-bleed cover surface with the shared hover feedback', () => {
    render(<DocumentCard document={makeDoc()} onOpen={vi.fn()} onDetails={vi.fn()} />);
    const card = screen.getByTestId('document-card-cover-1');
    expect(card.className).toContain('overflow-hidden');

    // No inner frame or padded thumbnail: the cover is pinned to the card box.
    const cover = screen.getByTestId('document-preview-cover-1');
    expect(cover.parentElement).toBe(card);

    // The card opts into the shared hover rule, which owns its ring and shadow.
    expect(card.className).toContain('ml-card-hover');
    // No utility scale/translate/shadow on the card: one stylesheet rule
    // decides the hover, so the pointer gate covers all of it.
    expect(card.className).not.toMatch(/hover:scale-/);
    expect(card.className).not.toMatch(/hover:-?translate-/);
    expect(card.className).not.toMatch(/hover:shadow-/);
  });

  test('hover changes only the ring and shadow, over 150ms, and never moves the card', () => {
    const base = cardHoverRule('.ml-card-hover');
    const hover = cssRule(hoverGatedCardRules(), '.ml-card-hover:hover');

    // The transition is the shared fast step, on box-shadow alone.
    expect(base).toMatch(/transition:\s*box-shadow var\(--dur-fast\) var\(--ease-out\)/);
    expect(base).toContain('var(--border-subtle)');
    expect(hover).toContain('var(--border-strong)');

    // No lift and nothing that resizes the box: neighbouring cards keep their
    // positions and the grid cannot overflow, even one column at 200% zoom.
    expect(`${base}\n${hover}`).not.toMatch(/transform:/);
    expect(hover).not.toMatch(/(^|\s)(width|height|margin|padding|inset|top|left|border(-width)?):/);
  });

  test('the hover state applies only to a fine pointer that can hover', () => {
    const gated = hoverGatedCardRules();
    expect(gated).toContain('.ml-card-hover:hover');
    // The hover rule exists nowhere outside the gate.
    expect(cssRule(globalCss.replace(gated, ''), '.ml-card-hover:hover')).toBe('');
  });

  test('a document without artwork gets a deterministic typographic cover from safe metadata', () => {
    const webDoc = makeDoc({
      id: 'cover-web',
      title: 'A Beginner’s Guide to Split Keyboards',
      author: 'Justin Lam',
      format: 'markdown',
      source: {
        kind: 'web',
        url: 'https://justinmklam.com/posts/2021/01/split-keyboard/',
        siteName: 'justinmklam.com',
        capturedAt: '2026-08-26T00:00:00.000Z',
      },
    });
    render(<DocumentCard document={webDoc} onOpen={vi.fn()} onDetails={vi.fn()} />);

    const generated = screen.getByTestId('generated-cover-cover-web');
    expect(generated.textContent).toContain('Web article');
    expect(generated.textContent).toContain('A Beginner’s Guide to Split Keyboards');
    expect(generated.textContent).toContain('justinmklam.com');
    // The gradient is derived from the id, so a document keeps its cover.
    expect(generated.className).toContain(coverGradientClass('cover-web'));
    expect(coverGradientClass('cover-web')).toBe(coverGradientClass('cover-web'));
    // Nothing document-supplied is rendered: no media elements on the cover.
    expect(generated.querySelector('img, video, audio, iframe, object, embed, canvas')).toBeNull();
  });

  test('the eyebrow marks web provenance only, never the file format', () => {
    render(<DocumentCard document={makeDoc({ format: 'epub' })} onOpen={vi.fn()} onDetails={vi.fn()} />);
    const generated = screen.getByTestId('generated-cover-cover-1');
    expect(generated.textContent).not.toMatch(/web article/i);
    expect(generated.textContent).not.toMatch(/epub/i);
  });

  test('title and author sit on the scrim with truncation and tooltips preserved', () => {
    render(<DocumentCard document={makeDoc()} onOpen={vi.fn()} onDetails={vi.fn()} />);
    const title = screen.getByTestId('document-title-cover-1');
    expect(title.className).toContain('truncate');
    expect(title.getAttribute('title')).toBe('The Annotated Turing');

    const meta = screen.getByTestId('document-meta-cover-1');
    expect(meta.className).toContain('truncate');
    expect(meta.textContent).toBe('Charles Petzold');
    expect(meta.getAttribute('title')).toBe('Charles Petzold');
  });

  test('file size is gone from the card while the details and list surfaces keep it', () => {
    render(<DocumentCard document={makeDoc()} onOpen={vi.fn()} onDetails={vi.fn()} />);
    expect(screen.queryByTestId('document-size-cover-1')).toBeNull();
    const card = screen.getByTestId('document-card-cover-1');
    expect(card.textContent).not.toMatch(/\d+(\.\d+)?\s?(B|KB|MB)\b/);
    // The formatter itself stays exported: the details modal and the list view
    // still render a size, and only the grid card dropped it.
    expect(formatFileSize(2 * 1024 * 1024)).toBe('2.0 MB');
  });

  test('a document with no author still reads as "Unknown author"', () => {
    render(<DocumentCard document={makeDoc({ author: null })} onOpen={vi.fn()} onDetails={vi.fn()} />);
    expect(screen.getByTestId('document-author-cover-1').textContent).toBe('Unknown author');
    expect(screen.getByTestId('document-meta-cover-1').textContent).toBe('Unknown author');
  });

  test('the details control is an icon button over the artwork, keyboard reachable, and does not open the reader', () => {
    const onOpen = vi.fn();
    const onDetails = vi.fn();
    render(<DocumentCard document={makeDoc()} onOpen={onOpen} onDetails={onDetails} />);

    const menu = screen.getByTestId('document-menu-cover-1');
    expect(menu.tagName).toBe('BUTTON');
    expect(menu.getAttribute('aria-label')).toBe('More actions for The Annotated Turing');
    // A drawn icon, not a text glyph, and not nested inside the open button.
    expect(menu.querySelector('svg')).not.toBeNull();
    expect(menu.textContent).toBe('');
    expect(menu.closest('[data-testid="read-doc-cover-1"]')).toBeNull();

    menu.focus();
    expect(document.activeElement).toBe(menu);
    fireEvent.click(menu);
    expect(onDetails).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  test('reading location reads on the scrim while progress is a hairline with progressbar semantics', () => {
    render(
      <DocumentCard
        document={makeDoc({
          readingPosition: {
            location: { format: 'pdf', pageIndex: 42, pageLabel: 'Page 43' },
            progress: 0.42,
            updatedAt: '2026-08-26T00:00:00.000Z',
          },
        })}
        onOpen={vi.fn()}
        onDetails={vi.fn()}
      />
    );
    expect(screen.getByTestId('preview-location-badge-cover-1').textContent).toContain('Page 43');
    // The visible percentage is gone from the scrim entirely — not hidden, not
    // relocated — and no stray "42%" survives anywhere on the card.
    expect(screen.queryByTestId('reading-progress-percent-cover-1')).toBeNull();
    expect(screen.getByTestId('document-card-cover-1').textContent).not.toContain('42%');

    const track = screen.getByTestId('reading-progress-track-cover-1');
    expect(track.className).toContain('bottom-0');
    expect(track.parentElement).toBe(screen.getByTestId('document-card-cover-1'));
    expect(screen.getByTestId('reading-progress-bar-cover-1')).toHaveStyle({ width: '42%' });

    // Assistive technology still gets the number the scrim no longer prints,
    // from the element that actually draws it.
    const bar = screen.getByRole('progressbar', {
      name: 'Reading progress for The Annotated Turing',
    });
    expect(bar).toBe(track);
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect(bar.getAttribute('aria-valuetext')).toBe('42% read');
  });

  test('an unstarted document shows its default location without false progress', () => {
    render(<DocumentCard document={makeDoc()} onOpen={vi.fn()} onDetails={vi.fn()} />);
    expect(screen.getByTestId('preview-location-badge-cover-1').textContent).toContain('Page 1');
    expect(screen.queryByTestId('reading-progress-percent-cover-1')).toBeNull();
    expect(screen.queryByTestId('reading-progress-track-cover-1')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  test('the title keeps level-2 heading semantics without nesting a heading in the button', () => {
    render(<DocumentCard document={makeDoc()} onOpen={vi.fn()} onDetails={vi.fn()} />);
    const title = screen.getByTestId('document-title-cover-1');
    expect(title.getAttribute('role')).toBe('heading');
    expect(title.getAttribute('aria-level')).toBe('2');
    // The heading is exposed by ARIA precisely because the scrim lives inside
    // the open button, where a real <h2> would be invalid nesting.
    expect(title.tagName).toBe('SPAN');
    expect(title.closest('button')).toBe(screen.getByTestId('read-doc-cover-1'));
    expect(
      screen.getByRole('heading', { level: 2, name: 'The Annotated Turing' })
    ).toBe(title);
  });

  test('the grid card carries no source emblem; the generated cover keeps plain attribution', () => {
    render(
      <DocumentCard
        document={makeDoc({
          id: 'cover-web',
          format: 'markdown',
          source: {
            kind: 'web',
            url: 'https://justinmklam.com/posts/2021/01/split-keyboard/',
            siteName: 'justinmklam.com',
            capturedAt: '2026-08-26T00:00:00.000Z',
          },
        })}
        onOpen={vi.fn()}
        onDetails={vi.fn()}
      />
    );
    const generated = screen.getByTestId('generated-cover-cover-web');
    const eyebrow = generated.firstElementChild!;
    const attribution = generated.lastElementChild!;
    // Secondary cover type is solid white set smaller than the title; text is
    // never opacity-composed, so its contrast does not depend on the artwork.
    expect(eyebrow.textContent).toBe('Web article');
    expectSolidWhiteType(eyebrow);
    expectSolidWhiteType(attribution);
    // Attribution remains as plain type inside the generated cover.
    expect(attribution.textContent).toBe('justinmklam.com');

    // No emblem badge over the artwork or on the scrim: the site name is not
    // repeated as a chip, and nothing on the card claims web provenance twice.
    expect(screen.queryByTestId('source-badge-cover-web')).toBeNull();
    expect(screen.getByTestId('read-doc-cover-web').textContent).not.toContain(
      'justinmklam.com'
    );
  });

  test('both focusable card surfaces carry a cover-safe two-band focus indicator', () => {
    render(<DocumentCard document={makeDoc()} onOpen={vi.fn()} onDetails={vi.fn()} />);
    const open = screen.getByTestId('read-doc-cover-1');
    const menu = screen.getByTestId('document-menu-cover-1');

    // A white band plus a near-black band: whatever the artwork happens to be,
    // one of the two contrasts with it. The themed accent ring alone could not
    // promise that over an image the app does not control.
    expect(open.className).toContain(
      'focus-visible:shadow-[inset_0_0_0_3px_#ffffff,inset_0_0_0_6px_rgba(10,10,12,0.92)]'
    );
    expect(open.className).not.toContain('focus-visible:ring-focus-ring');
    expect(menu.className).toContain('focus-visible:ring-white');
    expect(menu.className).toContain('focus-visible:shadow-[0_0_0_4px_rgba(10,10,12,0.92)]');
    expect(menu.className).not.toContain('focus-visible:ring-focus-ring');

    // Both bands are focus-only, so the unfocused card keeps 7a's clean edge.
    expect(open.className).not.toMatch(/(^|\s)shadow-\[/);
    expect(menu.className).not.toMatch(/(^|\s)shadow-\[/);
  });

  test('passes automated accessibility checks with artwork, status chips and progress present', async () => {
    render(
      <DocumentCard
        document={makeDoc({
          storageMode: 'link',
          storageHealth: 'missing',
          readingPosition: {
            location: { format: 'pdf', pageIndex: 42, pageLabel: 'Page 43' },
            progress: 0.42,
            updatedAt: '2026-08-26T00:00:00.000Z',
          },
        })}
        onOpen={vi.fn()}
        onDetails={vi.fn()}
      />
    );
    // Storage status stays available over the artwork without a card frame.
    expect(screen.getByTestId('storage-mode-cover-1').textContent).toBe('Linked');
    expect(screen.getByTestId('health-badge-cover-1').textContent).toContain('Missing');
    // Without a message from main, the chip still explains itself.
    expect(screen.getByTestId('health-badge-cover-1')).toHaveAttribute('title', 'File missing from original path');
    const results = await axe.run(document.body, {
      // `region` only fires because a single card is mounted outside the page
      // landmarks; the whole-library axe run in library-ui.spec.tsx covers it.
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
});
