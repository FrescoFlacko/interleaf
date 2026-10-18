import { describe, expect, it } from 'vitest';
import {
  selectionToolbarBounds,
  selectionToolbarPosition,
} from '../../src/renderer/features/reader/components/selection-toolbar-position';

const WINDOW = { width: 1280, height: 800 };
// The reader at 1280 with the companion open from x=1032.
const READER = { left: 260, top: 48, width: 772, height: 752 };
const TOOLBAR = { width: 610, height: 44 };

describe('selection toolbar bounds', () => {
  it('uses the reader rect clipped to the window', () => {
    expect(selectionToolbarBounds(READER, WINDOW)).toEqual(READER);
    expect(selectionToolbarBounds({ left: -20, top: 0, width: 2000, height: 900 }, WINDOW))
      .toEqual({ left: 0, top: 0, width: 1280, height: 800 });
  });

  it('falls back to the window when there is no usable reader rect', () => {
    const windowRect = { left: 0, top: 0, width: 1280, height: 800 };
    expect(selectionToolbarBounds(null, WINDOW)).toEqual(windowRect);
    expect(selectionToolbarBounds({ left: 0, top: 0, width: 0, height: 0 }, WINDOW)).toEqual(windowRect);
    expect(selectionToolbarBounds({ left: 1400, top: 0, width: 100, height: 100 }, WINDOW)).toEqual(windowRect);
  });
});

describe('selection toolbar position', () => {
  it('never crosses the companion edge for a selection near it', () => {
    // The audited case: a selection at x≈490 put the toolbar's right edge at 1100.
    const position = selectionToolbarPosition({ left: 490, top: 400, width: 200, height: 20 }, TOOLBAR, READER);
    expect(position.left + TOOLBAR.width).toBeLessThanOrEqual(READER.left + READER.width - 8);
    expect(position.left).toBe(414);
  });

  it('narrows to the reader when the toolbar is wider than it', () => {
    const narrow = { left: 0, top: 0, width: 400, height: 800 };
    const position = selectionToolbarPosition({ left: 100, top: 400, width: 50, height: 20 }, TOOLBAR, narrow);
    expect(position.maxWidth).toBe(384);
    expect(position.left).toBe(8);
  });

  it('sits above the selection, and flips below when there is no room above', () => {
    expect(selectionToolbarPosition({ left: 300, top: 400, width: 50, height: 20 }, TOOLBAR, READER).top).toBe(348);
    expect(selectionToolbarPosition({ left: 300, top: 70, width: 50, height: 20 }, TOOLBAR, READER).top).toBe(98);
  });

  it('stays inside the reader vertically when neither side fits', () => {
    const short = { left: 0, top: 100, width: 800, height: 120 };
    const tall = { width: 400, height: 180 };
    const { top } = selectionToolbarPosition({ left: 50, top: 150, width: 50, height: 20 }, tall, short);
    expect(top).toBe(108);
  });
});
