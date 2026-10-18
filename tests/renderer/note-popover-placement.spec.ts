// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  computeNotePopoverPlacement,
  POPOVER_GAP_PX,
  POPOVER_INSET_PX,
} from '../../src/renderer/features/reader/annotations/note-popover-placement';

const VIEWPORT = { width: 1024, height: 768 };
const WIDTH = 320;

function place(anchor: { left: number; top: number; right: number; bottom: number }, height: number, viewport = VIEWPORT) {
  return computeNotePopoverPlacement(anchor, { width: WIDTH, height }, viewport);
}

describe('note popover placement math', () => {
  it('prefers fully clear space above the anchor', () => {
    // Anchor mid-page: above has room (top 400 - 8 >= 200 + 8).
    const p = place({ left: 100, top: 400, right: 300, bottom: 420 }, 200);
    expect(p.top).toBe(400 - POPOVER_GAP_PX - 200);
    expect(p.left).toBe(100);
  });

  it('falls back to below when above lacks room, without covering the anchor', () => {
    // Anchor near the top: above cannot fit 300px; below can.
    const p = place({ left: 100, top: 40, right: 300, bottom: 60 }, 300);
    expect(p.top).toBe(60 + POPOVER_GAP_PX);
    expect(p.top).toBeGreaterThanOrEqual(60);
  });

  it('clamps horizontally to the viewport inset at narrow viewports (200% zoom)', () => {
    const narrow = { width: 360, height: 640 };
    const p = place({ left: 350, top: 300, right: 355, bottom: 310 }, 96, narrow);
    // maxLeft = 360 - 320 - 8 = 32; the anchor's left clamps to it.
    expect(p.left).toBe(32);
    const measuredWidth = Math.min(WIDTH, narrow.width - POPOVER_INSET_PX * 2);
    expect(p.left + measuredWidth).toBeLessThanOrEqual(narrow.width - POPOVER_INSET_PX + 1);
  });

  it('long multiline note with neither side fully fitting uses the roomier side clamped inside the viewport', () => {
    // 40vh-style long panel: height larger than the space on both sides.
    const height = 500;
    const p = place({ left: 100, top: 400, right: 300, bottom: 420 }, height);
    const roomierSideTop = 400 - POPOVER_GAP_PX - height; // above has 392 free, below 340
    expect(roomierSideTop).toBeLessThan(POPOVER_INSET_PX);
    expect(p.top).toBe(POPOVER_INSET_PX); // clamped, panel scrolls internally
  });

  it('maximum-length note stays inside the viewport even when taller than the viewport', () => {
    // A pathological measured height (max-length note before max-height CSS
    // clamps) can exceed the viewport; placement must clamp to the inset.
    const hugeHeight = 2000;
    const p = place({ left: 100, top: 380, right: 300, bottom: 400 }, hugeHeight);
    expect(p.top).toBeGreaterThanOrEqual(POPOVER_INSET_PX);
    expect(p.top).toBeLessThanOrEqual(VIEWPORT.height - POPOVER_INSET_PX);
  });

  it('never overlaps the anchor whenever either side has room', () => {
    // Above fits exactly: bubble bottom must sit at or above anchor top.
    const anchor = { left: 100, top: 300, right: 300, bottom: 320 };
    const height = 300 - POPOVER_INSET_PX - POPOVER_GAP_PX;
    const p = place(anchor, height);
    expect(p.top + height).toBeLessThanOrEqual(anchor.top + 1);
    // Below fits: bubble top must start at or below anchor bottom.
    const p2 = place({ left: 100, top: 40, right: 300, bottom: 60 }, 200);
    expect(p2.top).toBeGreaterThanOrEqual(60 - 1);
  });
});
