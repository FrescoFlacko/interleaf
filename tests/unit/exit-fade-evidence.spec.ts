import { describe, expect, it } from 'vitest';
import { exitFadeFailure, type ExitEvidence, type ExitFrame } from '../e2e/exit-fade-evidence';

function frame(t: number, phase: string, opacity: number, width = 256): ExitFrame {
  return {
    t, phase, opacity, width, left: 0, x: 0, duration: 100, property: 'opacity', overflow: 0,
    inert: phase === 'closed', ariaHidden: phase === 'closed' ? 'true' : null, animationStart: null,
  };
}

function closedFrames(start = 220): ExitFrame[] {
  return [0, 16, 32, 48, 64].map((offset) => frame(start + offset, 'closed', 0, 1));
}

function evidence(): ExitEvidence {
  return {
    click: 10,
    initial: frame(10, 'open', 1),
    closing: { ...frame(15, 'closing', 1), opacityAnimation: true, animationDuration: 100, opacityFrom: 1, opacityTo: 0 },
    terminal: frame(210, 'closed', 0, 1),
    starts: [],
    frames: [frame(5, 'open', 1), { ...frame(25, 'closing', 0.9), animationStart: 20 }, ...closedFrames()],
  };
}

describe('exit fade cadence evidence', () => {
  it('accepts a relevant stall with a real transition and safe state', () => {
    expect(exitFadeFailure(evidence(), 256)).toBeNull();
  });

  it('accepts zero partial samples only when the actual start and starvation are observed', () => {
    const e = evidence();
    e.frames = [{ ...frame(20, 'closing', 1), animationStart: 20 }, ...closedFrames()];
    expect(exitFadeFailure(e, 256)).toBeNull();
  });

  it('accepts a transition ready observation without relying on a protocol sample', () => {
    const e = evidence();
    e.starts = [{ t: 21, start: 20 }];
    e.frames = [frame(20, 'closing', 1), ...closedFrames()];
    expect(exitFadeFailure(e, 256)).toBeNull();
  });

  it('accepts one partial sample when most of the fade spans several measured intervals', () => {
    const e = evidence();
    e.frames = [{ ...frame(48.7, 'closing', 0.955), animationStart: 20 }, ...closedFrames()];
    expect(exitFadeFailure(e, 256)).toBeNull();
  });

  it('does not assume 60Hz when the same renderer normally delivers slower callbacks', () => {
    const e = evidence();
    e.frames = [{ ...frame(48.7, 'closing', 0.955), animationStart: 20 },
      ...[0, 33, 66, 99, 132].map((offset) => frame(220 + offset, 'closed', 0, 1))];
    expect(exitFadeFailure(e, 256)).toMatch(/starvation/);
  });

  it('accepts two distinct renderer samples with normal cadence', () => {
    const e = evidence();
    e.frames = [frame(5, 'open', 1), frame(25, 'closing', 0.8), frame(45, 'closing', 0.4), ...closedFrames()];
    expect(exitFadeFailure(e, 256)).toBeNull();
  });

  it('rejects adequate cadence with no fade', () => {
    const e = evidence();
    e.frames = [...[20, 40, 60, 80, 100, 120].map((t) => frame(t, 'closing', 1)), ...closedFrames()];
    e.frames[0] = { ...e.frames[0]!, animationStart: 20 };
    expect(exitFadeFailure(e, 256)).toMatch(/starvation/);
  });

  it('keeps the original thousandth-precision distinct-frame requirement', () => {
    const e = evidence();
    e.frames = [
      { ...frame(20, 'closing', 1), animationStart: 20 }, frame(40, 'closing', 0.5001),
      frame(60, 'closing', 0.5002), frame(80, 'closing', 0.5), frame(100, 'closing', 0.5),
      frame(120, 'closing', 0), ...closedFrames(),
    ];
    expect(exitFadeFailure(e, 256)).toMatch(/starvation/);
  });

  it('rejects a large gap outside the transition', () => {
    const e = evidence();
    e.frames = [...[20, 40, 60, 80, 100, 120].map((t) => frame(t, 'closing', 1)), ...closedFrames(400)];
    e.frames[0] = { ...e.frames[0]!, animationStart: 20 };
    expect(exitFadeFailure(e, 256)).toMatch(/starvation/);
  });

  it('does not count a gap before the real click as fade starvation', () => {
    const e = evidence();
    e.frames = [frame(-200, 'open', 1), frame(5, 'open', 1),
      ...[20, 40, 60, 80, 100, 120].map((t) => frame(t, 'closing', 1)), ...closedFrames()];
    e.frames[2] = { ...e.frames[2]!, animationStart: 20 };
    expect(exitFadeFailure(e, 256)).toMatch(/starvation/);
  });

  it('rejects a gap that overlaps less than half of the real fade', () => {
    const e = evidence();
    e.frames = [
      { ...frame(20, 'closing', 1), animationStart: 20 }, frame(40, 'closing', 1),
      frame(89, 'closing', 0.5), frame(100, 'closing', 0.5), frame(120, 'closing', 0), ...closedFrames(),
    ];
    expect(exitFadeFailure(e, 256)).toMatch(/starvation/);
  });

  it('rejects a long gap when ordinary renderer cadence is unavailable', () => {
    const e = evidence();
    e.frames = [e.frames[0]!, e.frames[1]!, frame(220, 'closed', 0, 1), frame(236, 'closed', 0, 1)];
    expect(exitFadeFailure(e, 256)).toMatch(/calibration/);
  });

  it('does not infer an animation start from closing or a large gap', () => {
    const e = evidence();
    e.closing = { ...e.closing!, animationStart: null };
    e.frames[1] = { ...e.frames[1]!, animationStart: null };
    expect(exitFadeFailure(e, 256)).toMatch(/actual transition start/);
  });

  it('rejects a missing transition or a wrong declared or actual duration', () => {
    const e = evidence();
    e.closing = { ...e.closing!, opacityAnimation: false };
    expect(exitFadeFailure(e, 256)).toMatch(/transition/);
    e.closing = { ...e.closing, opacityAnimation: true, duration: 200 };
    expect(exitFadeFailure(e, 256)).toMatch(/transition/);
    e.closing = { ...e.closing, duration: 100, animationDuration: 200 };
    expect(exitFadeFailure(e, 256)).toMatch(/transition/);
    e.closing = { ...e.closing, animationDuration: 100, opacityTo: 1 };
    expect(exitFadeFailure(e, 256)).toMatch(/transition/);
  });

  it('rejects motion, width changes, overflow or a non-inert terminal even with a stall', () => {
    const e = evidence();
    e.closing = { ...e.closing!, left: 4 };
    expect(exitFadeFailure(e, 256)).toMatch(/geometry/);
    e.closing = { ...e.closing, left: 0 };
    e.frames[1] = { ...e.frames[1]!, width: 230 };
    expect(exitFadeFailure(e, 256)).toMatch(/geometry/);
    e.frames[1] = { ...e.frames[1], width: 256, overflow: 2 };
    expect(exitFadeFailure(e, 256)).toMatch(/geometry/);
    e.frames[1] = { ...e.frames[1], overflow: 0 };
    e.terminal = { ...e.terminal!, inert: false };
    expect(exitFadeFailure(e, 256)).toMatch(/terminal/);
    e.terminal = { ...e.terminal, inert: true, ariaHidden: null };
    expect(exitFadeFailure(e, 256)).toMatch(/terminal/);
  });

  it('requires the open baseline at the actual click', () => {
    const e = evidence();
    e.initial = { ...e.initial, t: 5 };
    expect(exitFadeFailure(e, 256)).toMatch(/baseline/);
    e.initial = { ...e.initial, t: 10, opacity: 0 };
    expect(exitFadeFailure(e, 256)).toMatch(/baseline/);
  });

  it('rejects an instant close or an increasing fade', () => {
    const e = evidence();
    e.terminal = frame(35, 'closed', 0, 1);
    expect(exitFadeFailure(e, 256)).toMatch(/timing/);
    e.terminal = frame(210, 'closed', 0, 1);
    e.frames = [frame(25, 'closing', 0.4), frame(45, 'closing', 0.8), frame(220, 'closed', 0, 1)];
    expect(exitFadeFailure(e, 256)).toMatch(/direction/);
  });
});
