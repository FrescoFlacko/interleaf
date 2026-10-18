// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  captureReflowAnchor,
  restoreReflowAnchor,
} from '../../src/renderer/features/reader/adapters/reflow-anchor';

/**
 * Reflowable readers cannot keep a pixel offset across a width change: the text
 * re-wraps, every block's height changes, and the same `scrollTop` points at
 * different words. These tests use a small deterministic layout model — blocks
 * stacked at known heights inside a fixed viewport — so a reflow can be
 * expressed exactly as "every block became taller" and the question the code
 * has to answer is isolated: are the reader's words still at the top?
 */

const VIEWPORT_TOP = 100;
const VIEWPORT_HEIGHT = 600;
const GAP = 10;

type Layout = {
  readonly scroller: HTMLElement;
  readonly blocks: readonly HTMLElement[];
  /** Re-lays out the stack with new per-block heights, as a reflow would. */
  reflow: (heights: readonly number[]) => void;
};

function buildLayout(heights: readonly number[]): Layout {
  const scroller = document.createElement('div');
  document.body.append(scroller);
  let current = [...heights];

  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => VIEWPORT_HEIGHT });
  Object.defineProperty(scroller, 'scrollHeight', {
    configurable: true,
    get: () => current.reduce((total, height) => total + height + GAP, 0),
  });
  scroller.getBoundingClientRect = () =>
    ({ top: VIEWPORT_TOP, bottom: VIEWPORT_TOP + VIEWPORT_HEIGHT, height: VIEWPORT_HEIGHT }) as DOMRect;

  const blocks = heights.map((_unused, index) => {
    const block = document.createElement('p');
    scroller.append(block);
    block.getBoundingClientRect = () => {
      const offset = current.slice(0, index).reduce((total, height) => total + height + GAP, 0);
      const height = current[index] ?? 0;
      const top = VIEWPORT_TOP - scroller.scrollTop + offset;
      return { top, bottom: top + height, height } as DOMRect;
    };
    return block;
  });

  return {
    scroller,
    blocks,
    reflow: (next) => { current = [...next]; },
  };
}

describe('reflow reading anchor', () => {
  let layout: Layout;

  beforeEach(() => {
    // Ten blocks of 200px: the viewport shows three at a time.
    layout = buildLayout(Array.from({ length: 10 }, () => 200));
  });

  afterEach(() => {
    layout.scroller.remove();
  });

  it('captures the block under the top of the viewport and how far into it', () => {
    // 4 full blocks (840px) plus half of the fifth.
    layout.scroller.scrollTop = 840 + 100;
    const anchor = captureReflowAnchor(layout.scroller, layout.blocks);

    expect(anchor?.element).toBe(layout.blocks[4]);
    expect(anchor?.progressWithinElement).toBeCloseTo(0.5, 5);
  });

  it('takes the block below when the viewport starts in the gap between two', () => {
    // Exactly in the 10px gap after the third block: nothing is under the top
    // edge, and what the reader is about to read is the fourth block.
    layout.scroller.scrollTop = 3 * 210 - 5;
    const anchor = captureReflowAnchor(layout.scroller, layout.blocks);

    expect(anchor?.element).toBe(layout.blocks[3]);
    expect(anchor?.progressWithinElement).toBe(0);
  });

  it('keeps the reader on the same words when narrowing makes every block taller', () => {
    layout.scroller.scrollTop = 840 + 100;
    const anchor = captureReflowAnchor(layout.scroller, layout.blocks);

    // Narrower column: the same text now needs 320px per block. A preserved
    // scrollTop would land in the middle of the third block instead.
    layout.reflow(Array.from({ length: 10 }, () => 320));
    restoreReflowAnchor(layout.scroller, anchor);

    const restored = captureReflowAnchor(layout.scroller, layout.blocks);
    expect(restored?.element).toBe(layout.blocks[4]);
    expect(restored?.progressWithinElement).toBeCloseTo(0.5, 5);
    // And it really did move: the naive answer would have been to stay put.
    expect(layout.scroller.scrollTop).not.toBe(940);
  });

  it('keeps the reader on the same words when widening makes every block shorter', () => {
    layout.scroller.scrollTop = 3 * 210;
    const anchor = captureReflowAnchor(layout.scroller, layout.blocks);
    expect(anchor?.element).toBe(layout.blocks[3]);

    // Wider column: the same text fits in 120px per block, so the reader's
    // paragraph is now much earlier in the document than its old offset.
    layout.reflow(Array.from({ length: 10 }, () => 120));
    restoreReflowAnchor(layout.scroller, anchor);

    expect(captureReflowAnchor(layout.scroller, layout.blocks)?.element).toBe(layout.blocks[3]);
    expect(layout.scroller.scrollTop).toBe(3 * 130);
  });

  it('clamps to the scrollable range rather than scrolling past the end', () => {
    layout.scroller.scrollTop = 9 * 210;
    const anchor = captureReflowAnchor(layout.scroller, layout.blocks);
    expect(anchor?.element).toBe(layout.blocks[9]);

    // The document collapsed to less than a viewport: there is no position that
    // puts the last block at the top, so the reader lands at the end.
    layout.reflow(Array.from({ length: 10 }, () => 20));
    restoreReflowAnchor(layout.scroller, anchor);

    const maxScrollTop = layout.scroller.scrollHeight - VIEWPORT_HEIGHT;
    expect(layout.scroller.scrollTop).toBe(Math.max(0, maxScrollTop));
    expect(layout.scroller.scrollTop).toBeGreaterThanOrEqual(0);
  });

  it('leaves the reader alone when there is nothing measurable to anchor to', () => {
    const empty = buildLayout([]);
    empty.scroller.scrollTop = 400;

    const anchor = captureReflowAnchor(empty.scroller, empty.blocks);
    expect(anchor).toBeNull();

    // A null anchor is a decision not to guess, not an instruction to jump.
    restoreReflowAnchor(empty.scroller, anchor);
    expect(empty.scroller.scrollTop).toBe(400);
    empty.scroller.remove();
  });

  it('ignores an anchor whose block no longer belongs to the scroller', () => {
    layout.scroller.scrollTop = 840;
    const anchor = captureReflowAnchor(layout.scroller, layout.blocks);
    expect(anchor).not.toBeNull();

    // Re-rendering the document replaces the elements; a stale anchor must not
    // be used to compute a scroll position in a document it is not part of.
    layout.blocks[4]?.remove();
    restoreReflowAnchor(layout.scroller, anchor);
    expect(layout.scroller.scrollTop).toBe(840);
  });

  it('skips collapsed blocks that occupy no space', () => {
    const collapsed = buildLayout([200, 0, 0, 200]);
    collapsed.scroller.scrollTop = 210;
    const anchor = captureReflowAnchor(collapsed.scroller, collapsed.blocks);

    // A zero-height block is not somewhere a reader can be.
    expect(anchor?.element).toBe(collapsed.blocks[3]);
    collapsed.scroller.remove();
  });
});
