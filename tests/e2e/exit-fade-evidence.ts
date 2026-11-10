/** Read-only observations in the renderer's performance timebase. */
export type ExitFrame = {
  t: number;
  phase: string | null;
  opacity: number;
  width: number;
  left: number;
  x: number;
  duration: number;
  property: string;
  overflow: number;
  inert: boolean;
  ariaHidden: string | null;
  animationStart: number | null;
};

export type ExitEvidence = {
  click: number | null;
  initial: ExitFrame;
  closing: (ExitFrame & { opacityAnimation: boolean; animationDuration: number | null; opacityFrom: number | null; opacityTo: number | null }) | null;
  frames: ExitFrame[];
  starts: { t: number; start: number }[];
  terminal: ExitFrame | null;
};

/** Only protocol reads in the real click's 500 ms window can prove the exit. */
export const EXIT_PROTOCOL_WINDOW_MS = 500;

export function exitProtocolWindow<T extends { readonly observedAt: number }>(frames: readonly T[], click: number | null): T[] {
  if (click === null || !Number.isFinite(click)) return [];
  return frames.filter(({ observedAt }) => Number.isFinite(observedAt)
    && observedAt >= click && observedAt - click <= EXIT_PROTOCOL_WINDOW_MS);
}

type Closing = NonNullable<ExitEvidence['closing']>;

function openAtClick(initial: ExitFrame, click: number | null, expectedWidth: number): boolean {
  return click !== null && initial.t === click && initial.phase === 'open' && initial.opacity === 1
    && !initial.inert && initial.ariaHidden !== 'true' && initial.overflow <= 1
    && Math.abs(initial.width - expectedWidth) <= 0.5 && Math.abs(initial.x) <= 0.5;
}

function hasExitTransition(closing: Closing, click: number): boolean {
  return closing.opacityAnimation && closing.t >= click && closing.phase === 'closing'
    && closing.duration === 100 && closing.animationDuration === 100
    && closing.opacityFrom === 1 && closing.opacityTo === 0 && /(^|,)\s*(opacity|all)(,|$)/u.test(closing.property);
}

function holdsGeometry(frame: ExitFrame, left: number, width: number): boolean {
  return Number.isFinite(frame.width) && Number.isFinite(frame.left) && Number.isFinite(frame.x)
    && Math.abs(frame.width - width) <= 0.5 && Math.abs(frame.left - left) <= 0.5 && Math.abs(frame.x) <= 0.5;
}

function closedSafely(terminal: ExitFrame): boolean {
  return Number.isFinite(terminal.t) && Number.isFinite(terminal.width) && Number.isFinite(terminal.opacity)
    && terminal.phase === 'closed' && terminal.width >= 0 && terminal.width <= 2 && terminal.opacity <= 0.02
    && terminal.inert && terminal.ariaHidden === 'true';
}

function invalidFrame(frames: ExitFrame[], initialLeft: number, expectedWidth: number): string | null {
  for (const [index, frame] of frames.entries()) {
    if (frame.phase !== 'closing' && frame.phase !== 'closed') return 'invalid closing phase';
    if (!Number.isFinite(frame.t) || !Number.isFinite(frame.width) || !Number.isFinite(frame.opacity)
      || frame.opacity < 0 || frame.opacity > 1 || frame.overflow > 1
      || (frame.width > 2 && !holdsGeometry(frame, initialLeft, expectedWidth))) return 'invalid frame geometry';
    if (index > 0 && frame.opacity > frames[index - 1]!.opacity + 0.0075) return 'invalid fade direction';
  }
  return null;
}

function observedStart(e: ExitEvidence, closing: Closing, terminal: ExitFrame, relevant: ExitFrame[]): { time: number; observedAt: number } | null {
  const ready = e.starts.find((sample) => sample.t >= closing.t && sample.t <= terminal.t);
  if (ready) return { time: ready.start, observedAt: ready.t };
  const sample = [closing, ...relevant].find((frame) => frame.animationStart !== null);
  return sample?.animationStart == null ? null : { time: sample.animationStart, observedAt: sample.t };
}

/** Measure this renderer after closure; an unknown cadence never grants an exception. */
function postCloseInterval(frames: ExitFrame[], terminal: number): number | null {
  const after = frames.filter((frame) => frame.t >= terminal && frame.t <= terminal + 400);
  const intervals = after.slice(1).map((frame, index) => frame.t - after[index]!.t).filter((interval) => interval > 0);
  if (intervals.length < 3) return null;
  intervals.sort((a, b) => a - b);
  return intervals[Math.floor(intervals.length / 2)] ?? null;
}

function coversFadeGap(frames: ExitFrame[], start: number, terminal: number, interval: number): boolean {
  // Cover at least half the fade and three observed renderer intervals. The
  // latter leaves at least two normal callback opportunities inside the gap.
  const minimum = Math.max(50, 3 * interval);
  return frames.some((next, index) => {
    if (index === 0) return false;
    const previous = frames[index - 1]!;
    return Math.min(next.t, start + 100, terminal) - Math.max(previous.t, start) >= minimum;
  });
}

/** Refuse the cadence exception unless the transition and its time window are established. */
export function exitFadeFailure(e: ExitEvidence, expectedWidth: number): string | null {
  const { initial, closing, terminal, click, frames } = e;
  if (!openAtClick(initial, click, expectedWidth)) return 'missing open baseline';
  if (click === null || closing === null || !hasExitTransition(closing, click)) return 'missing 100ms opacity transition';
  if (!holdsGeometry(closing, initial.left, expectedWidth) || closing.overflow > 1) return 'invalid closing geometry';
  if (terminal === null || !closedSafely(terminal)) return 'missing closed terminal';
  if (frames.some((frame, index) => !Number.isFinite(frame.t) || (index > 0 && frame.t < frames[index - 1]!.t))) return 'invalid renderer cadence';
  const relevant = frames.filter((frame) => frame.t >= closing.t && frame.t <= terminal.t);
  const invalid = invalidFrame(relevant, initial.left, expectedWidth);
  if (invalid !== null) return invalid;
  const start = observedStart(e, closing, terminal, relevant);
  if (start && (!Number.isFinite(start.time) || !Number.isFinite(start.observedAt) || start.time < closing.t - 1
    || start.time > closing.t + 100 || start.time > start.observedAt + 1)) return 'invalid transition start';
  if (terminal.t < (start?.time ?? closing.t) + 95) return 'invalid transition timing';
  const partial = relevant.filter((frame) => frame.opacity > 0.02 && frame.opacity < 0.98);
  if (new Set(partial.map((frame) => Math.round(frame.opacity * 1000) / 1000)).size >= 2) return null;
  if (start === null) return 'missing actual transition start for cadence exception';
  const interval = postCloseInterval(frames, terminal.t);
  if (interval === null) return 'insufficient renderer cadence calibration';
  return coversFadeGap(frames, start.time, terminal.t, interval) ? null : 'insufficient fade frames without relevant renderer starvation';
}
