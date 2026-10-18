// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  SUBMENU_GAP,
  SUBMENU_WIDTH,
  aimsAtSubmenu,
  submenuPosition,
  submenuSide,
} from '../../src/renderer/features/chat/reasoning-submenu-geometry';
import {
  AIM_DELAY_MS,
  HOVER_INTENT_MS,
  LEAVE_GRACE_MS,
  useSubmenuIntent,
} from '../../src/renderer/features/chat/use-submenu-intent';

const box = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height });

describe('submenuSide', () => {
  it('opens right when the flyout fits, then left, then in place', () => {
    expect(submenuSide(box(100, 0, 288, 200), 1024)).toBe('right');
    // 8px from the right edge is the limit.
    const exact = 100 + 288 + SUBMENU_GAP + SUBMENU_WIDTH + 8;
    expect(submenuSide(box(100, 0, 288, 200), exact)).toBe('right');
    expect(submenuSide(box(100, 0, 288, 200), exact - 1)).toBe('nested');
    expect(submenuSide(box(400, 0, 288, 200), 700)).toBe('left');
    expect(submenuSide(box(8, 0, 264, 200), 280)).toBe('nested');
  });
});

describe('submenuPosition', () => {
  it('sits level with the row beside the picker, never over it', () => {
    const picker = box(100, 50, 288, 232);
    const row = box(100, 120, 288, 28);
    expect(submenuPosition('right', picker, row, 160, 800)).toEqual({ left: 388 + SUBMENU_GAP, top: 116 });
    expect(submenuPosition('left', picker, row, 160, 800)).toEqual({ left: 100 - SUBMENU_GAP - SUBMENU_WIDTH, top: 116 });
  });

  it('clamps into the viewport with an 8px margin', () => {
    const picker = box(100, 0, 288, 232);
    expect(submenuPosition('right', picker, box(100, 0, 288, 28), 160, 800).top).toBe(8);
    expect(submenuPosition('right', picker, box(100, 700, 288, 28), 160, 800).top).toBe(800 - 160 - 8);
    // Taller than the viewport: pinned to the top margin, scrolling inside.
    expect(submenuPosition('right', picker, box(100, 300, 288, 28), 900, 800).top).toBe(8);
  });
});

describe('aimsAtSubmenu', () => {
  const flyout = box(400, 100, 184, 200);

  it('is true for a path heading into the flyout and false for one heading away', () => {
    expect(aimsAtSubmenu({ x: 300, y: 150 }, { x: 320, y: 160 }, flyout)).toBe(true);
    expect(aimsAtSubmenu({ x: 300, y: 150 }, { x: 290, y: 170 }, flyout)).toBe(false);
    expect(aimsAtSubmenu({ x: 300, y: 150 }, { x: 320, y: 400 }, flyout)).toBe(false);
  });

  it('is false when the pointer has not moved', () => {
    expect(aimsAtSubmenu({ x: 300, y: 150 }, { x: 300, y: 150 }, flyout)).toBe(false);
  });

  it('works toward a flyout on the left as well', () => {
    const left = box(0, 100, 184, 200);
    expect(aimsAtSubmenu({ x: 300, y: 150 }, { x: 280, y: 160 }, left)).toBe(true);
    expect(aimsAtSubmenu({ x: 300, y: 150 }, { x: 320, y: 160 }, left)).toBe(false);
  });
});

describe('useSubmenuIntent', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function setup(initial: { openKey: string | null; pinned?: boolean; hoverEnabled?: boolean; flyout?: ReturnType<typeof box> }) {
    const setOpenKey = vi.fn<(key: string | null) => void>();
    const element = document.createElement('div');
    const flyout = initial.flyout;
    if (flyout !== undefined) element.getBoundingClientRect = () => DOMRect.fromRect({ x: flyout.left, y: flyout.top, width: flyout.right - flyout.left, height: flyout.bottom - flyout.top });
    const submenuRef = { current: flyout === undefined ? null : element };
    const hook = renderHook(() => useSubmenuIntent({
      openKey: initial.openKey,
      pinned: initial.pinned ?? false,
      hoverEnabled: initial.hoverEnabled ?? true,
      submenuRef,
      setOpenKey,
    }));
    return { intent: () => hook.result.current, setOpenKey };
  }
  const mouse = (x: number, y: number) => ({ clientX: x, clientY: y, pointerType: 'mouse' });

  it('opens after the hover intent, and a row without levels cancels it', () => {
    const { intent, setOpenKey } = setup({ openKey: null });
    intent().rowPointerMove('a', mouse(10, 10));
    act(() => { vi.advanceTimersByTime(HOVER_INTENT_MS - 1); });
    expect(setOpenKey).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(setOpenKey).toHaveBeenCalledWith('a');

    setOpenKey.mockClear();
    intent().rowPointerMove('b', mouse(10, 40));
    intent().rowPointerMove(null, mouse(10, 70));
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(setOpenKey).not.toHaveBeenCalled();
  });

  it('waits out the safe-triangle delay while the pointer heads for the open flyout', () => {
    const { intent, setOpenKey } = setup({ openKey: 'a', flyout: box(400, 0, 184, 200) });
    intent().rowPointerMove('a', mouse(300, 20));
    intent().rowPointerMove('b', mouse(320, 30));
    act(() => { vi.advanceTimersByTime(HOVER_INTENT_MS); });
    expect(setOpenKey).not.toHaveBeenCalled();
    // Entering the flyout keeps it.
    intent().submenuPointerEnter();
    act(() => { vi.advanceTimersByTime(AIM_DELAY_MS); });
    expect(setOpenKey).not.toHaveBeenCalled();
  });

  it('switches after the delay when the pointer stops short of the flyout', () => {
    const { intent, setOpenKey } = setup({ openKey: 'a', flyout: box(400, 0, 184, 200) });
    intent().rowPointerMove('a', mouse(300, 20));
    intent().rowPointerMove('b', mouse(320, 30));
    act(() => { vi.advanceTimersByTime(AIM_DELAY_MS); });
    expect(setOpenKey).toHaveBeenCalledWith('b');
  });

  it('switches quickly when the pointer moves away from the flyout', () => {
    const { intent, setOpenKey } = setup({ openKey: 'a', flyout: box(400, 0, 184, 200) });
    intent().rowPointerMove('a', mouse(300, 20));
    intent().rowPointerMove('b', mouse(290, 60));
    act(() => { vi.advanceTimersByTime(HOVER_INTENT_MS); });
    expect(setOpenKey).toHaveBeenCalledWith('b');
  });

  it('closes after the grace period, unless the pointer comes back', () => {
    const { intent, setOpenKey } = setup({ openKey: 'a' });
    intent().submenuPointerLeave();
    act(() => { vi.advanceTimersByTime(LEAVE_GRACE_MS - 1); });
    intent().submenuPointerEnter();
    act(() => { vi.advanceTimersByTime(LEAVE_GRACE_MS); });
    expect(setOpenKey).not.toHaveBeenCalled();

    intent().listPointerLeave();
    act(() => { vi.advanceTimersByTime(LEAVE_GRACE_MS); });
    expect(setOpenKey).toHaveBeenCalledWith(null);
  });

  it('does nothing on hover while pinned, nested, or for touch', () => {
    const pinned = setup({ openKey: 'a', pinned: true });
    pinned.intent().rowPointerMove('b', mouse(10, 10));
    pinned.intent().listPointerLeave();
    const nested = setup({ openKey: null, hoverEnabled: false });
    nested.intent().rowPointerMove('b', mouse(10, 10));
    const touch = setup({ openKey: null });
    touch.intent().rowPointerMove('b', { clientX: 1, clientY: 1, pointerType: 'touch' });
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(pinned.setOpenKey).not.toHaveBeenCalled();
    expect(nested.setOpenKey).not.toHaveBeenCalled();
    expect(touch.setOpenKey).not.toHaveBeenCalled();
  });
});
