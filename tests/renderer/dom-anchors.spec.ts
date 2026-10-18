// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  applyDomHighlights,
  quoteContextForRange,
  rangeFromOffsets,
  rangeOffsetsWithin,
  resolveDomAnchor,
  subRangeWithin,
} from '../../src/renderer/features/reader/annotations/dom-anchors';
import { testAnnotation } from '../helpers/annotation';

/**
 * A `CSS.highlights` entry as these specs observe it.
 *
 * jsdom implements neither `Highlight` nor the registry, so each spec installs
 * the test double below; only the ranges it was constructed with are read back.
 */
type TestHighlightLike = { readonly ranges: readonly Range[] };

/** Installs the `Highlight` double on `target` and returns its registry. */
function installHighlightRegistry(target: Window): Map<string, TestHighlightLike> {
  const ranges = new Map<string, TestHighlightLike>();
  Object.defineProperty(target, 'CSS', { configurable: true, value: { highlights: ranges } });
  Object.defineProperty(target, 'Highlight', {
    configurable: true,
    value: class TestHighlight {
      readonly ranges: readonly Range[];
      constructor(...ranges: Range[]) { this.ranges = ranges; }
    },
  });
  return ranges;
}

describe('DOM annotation anchors', () => {
  it('round-trips offsets across nested text nodes', () => {
    const root = document.createElement('p');
    root.innerHTML = 'Before <strong>selected</strong> after';
    document.body.appendChild(root);
    const text = root.querySelector('strong')?.firstChild;
    expect(text).toBeTruthy();
    const range = document.createRange();
    range.setStart(text!, 1);
    range.setEnd(text!, 7);

    const offsets = rangeOffsetsWithin(root, range);
    expect(offsets).toEqual({ start: 8, end: 14 });
    expect(rangeFromOffsets(root, offsets!)?.toString()).toBe('electe');
    expect(quoteContextForRange(root, range)).toMatchObject({ exact: 'electe' });
  });

  it('reconstructs a range after native offsets drift using exact context', async () => {
    const root = document.createElement('p');
    root.textContent = 'Inserted words. Before selected quote after.';
    document.body.appendChild(root);
    const resolved = await resolveDomAnchor(
      root,
      { exact: 'selected quote', prefix: 'Before ', suffix: ' after.' },
      { nativeRange: { start: 7, end: 21 }, priorOffset: 7 }
    );
    expect(resolved?.range.toString()).toBe('selected quote');
    expect(resolved?.resolution.stage).toBe('quote');
  });

  it('injects highlight styles safely when an ebook document has no head element', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const frameDocument = iframe.contentDocument;
    const frameWindow = iframe.contentWindow;
    expect(frameDocument).toBeTruthy();
    expect(frameWindow).toBeTruthy();
    frameDocument!.head.remove();
    frameDocument!.body.textContent = 'highlight me';
    const ranges = installHighlightRegistry(frameWindow!);
    const range = frameDocument!.createRange();
    range.selectNodeContents(frameDocument!.body);
    const annotation = testAnnotation({
      id: 'highlight',
      anchor: { format: 'pdf', pageIndex: 0, quote: { exact: 'highlight me', prefix: '', suffix: '' } },
      selectedText: 'highlight me',
    });

    expect(applyDomHighlights(frameDocument!, [{ annotation, range }])).toBe(true);
    expect(frameDocument!.documentElement.querySelector('#interleaf-annotation-highlight-styles')).toBeTruthy();
    expect(ranges.has('interleaf-yellow')).toBe(true);
    iframe.remove();
  });

  it('generates style rules for all five highlight colors and notes', () => {
    const doc = document;
    const existingStyle = doc.getElementById('interleaf-annotation-highlight-styles');
    if (existingStyle) existingStyle.remove();

    const ranges = installHighlightRegistry(window);

    const p = document.createElement('p');
    p.textContent = 'Sample text for highlight testing.';
    document.body.appendChild(p);

    const range = document.createRange();
    range.selectNodeContents(p);

    const colors = ['yellow', 'blue', 'green', 'pink', 'purple'] as const;
    const annotations = colors.map((color) => ({
      annotation: testAnnotation({
        id: `hl-${color}`,
        anchor: { format: 'pdf', pageIndex: 0, quote: { exact: 'Sample text', prefix: '', suffix: '' } },
        selectedText: 'Sample text',
        color,
      }),
      range,
    }));

    expect(applyDomHighlights(document, annotations)).toBe(true);
    const injectedStyle = document.getElementById('interleaf-annotation-highlight-styles');
    expect(injectedStyle).toBeTruthy();
    const text = injectedStyle?.textContent ?? '';
    for (const color of colors) {
      expect(text).toContain(`::highlight(interleaf-${color})`);
      expect(ranges.has(`interleaf-${color}`)).toBe(true);
    }
    expect(text).toContain('::highlight(interleaf-note)');
    p.remove();
  });

  it('extracts subRanges across start, intermediate, and end elements', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <div id="sec1">Section 1 leading text. Section 1 selected start.</div>
      <div id="sec2">Section 2 intermediate full content.</div>
      <div id="sec3">Section 3 selected end. Section 3 trailing text.</div>
      <div id="sec4">Section 4 untouched text.</div>
    `;
    document.body.appendChild(container);

    const sec1 = container.querySelector('#sec1')!;
    const sec2 = container.querySelector('#sec2')!;
    const sec3 = container.querySelector('#sec3')!;
    const sec4 = container.querySelector('#sec4')!;

    const range = document.createRange();
    range.setStart(sec1.firstChild!, 24); // 'Section 1 selected start.'
    range.setEnd(sec3.firstChild!, 23);   // 'Section 3 selected end.'

    const sub1 = subRangeWithin(sec1, range);
    expect(sub1).toBeTruthy();
    expect(sub1?.toString()).toBe('Section 1 selected start.');

    const sub2 = subRangeWithin(sec2, range);
    expect(sub2).toBeTruthy();
    expect(sub2?.toString()).toBe('Section 2 intermediate full content.');

    const sub3 = subRangeWithin(sec3, range);
    expect(sub3).toBeTruthy();
    expect(sub3?.toString()).toBe('Section 3 selected end.');

    const sub4 = subRangeWithin(sec4, range);
    expect(sub4).toBeNull();

    container.remove();
  });

  it('applies multi-segment ranges for a single annotation to CSS.highlights', () => {
    const ranges = installHighlightRegistry(window);

    const p1 = document.createElement('p');
    p1.textContent = 'Page 1 highlight segment.';
    const p2 = document.createElement('p');
    p2.textContent = 'Page 2 highlight segment.';
    document.body.append(p1, p2);

    const r1 = document.createRange();
    r1.selectNodeContents(p1);
    const r2 = document.createRange();
    r2.selectNodeContents(p2);

    const annotation = testAnnotation({
      id: 'multi-hl',
      anchor: {
        format: 'pdf',
        pageIndex: 0,
        quote: { exact: 'Page 1 highlight segment.\nPage 2 highlight segment.', prefix: '', suffix: '' },
      },
      selectedText: 'Page 1 highlight segment.\nPage 2 highlight segment.',
      color: 'blue',
    });

    expect(applyDomHighlights(document, [
      { annotation, range: r1 },
      { annotation, range: r2 },
    ])).toBe(true);

    const blueHighlight = ranges.get('interleaf-blue');
    expect(blueHighlight).toBeTruthy();
    expect(blueHighlight?.ranges).toHaveLength(2);

    p1.remove();
    p2.remove();
  });
});
